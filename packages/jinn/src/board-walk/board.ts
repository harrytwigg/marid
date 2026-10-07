import { initDb } from "../shared/db.js";
import { todoHoldRefusal } from "../work-items/todo-hold.js";
import type { Session } from "../shared/types.js";
import { listSessionsByWorkItem } from "../sessions/registry.js";
import { listWorkItems, type WorkItem, type WorkItemStatus } from "../work-items/store.js";
import { commentsTail } from "../work-items/comments.js";
import { listRelations } from "../work-items/relations.js";
import { getWorkItemLabels } from "../work-items/labels.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";
import { readStopCause } from "../work-items/stop-cause.js";
import { readBlockRecord } from "../work-items/blocks.js";
import { listWorkItemEvents } from "../work-items/event-log.js";
import { OPERATOR_ASSIGNEE } from "../work-items/assignment.js";
import { findLinks, type LinkResolver, type LinkState } from "./pr-state.js";
import { startDateHold } from "../work-items/start-date.js";

/**
 * The board as the walk reads it: every open Todo with what its gates could
 * hang on — text, comments, relations and the status of what they point at,
 * dates, the stop cause, linked GitHub PRs and issues with their real state,
 * and whether anything is running on it.
 *
 * Open means `backlog`, `blocked` and `executing`. `in_review` is the operator's
 * desk and `done`/`cancelled` are closed; the walk touches none of them.
 *
 * The walk's model reads the board through its tools (turn.ts): one line per
 * Todo to go through the board, and one Todo in full when it needs the
 * detail (board-render.ts). Every part of a Todo is capped, so one stays a
 * few kilobytes however long its thread.
 */

export const OPEN_STATUSES: readonly WorkItemStatus[] = ["backlog", "blocked", "executing"];

const TITLE_CHARS = 200;
const BODY_CHARS = 1200;
const COMMENT_CHARS = 400;
const COMMENTS_PER_TODO = 4;
const LINKS_PER_TODO = 6;

export interface BoardTodo {
  id: string;
  title: string;
  status: WorkItemStatus;
  /** When it entered this status. */
  statusSince: string;
  assignee: string | null;
  priority: number;
  department: string | null;
  labels: string[];
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  dueAt: string | null;
  /** Nothing starts it before this; the Dispatcher refuses until then. */
  startAt: string | null;
  /** The start date holds it now (a backlog Todo whose date is still ahead). */
  startHeld?: boolean;
  body?: string;
  comments: Array<{ author: string; authorKind: string; at: string; body: string }>;
  commentsTotal: number;
  relations: Array<{ kind: string; direction: "out" | "in"; other: { id: string; title: string; status: WorkItemStatus } }>;
  stop?: { blockKind?: string; parkedUntil?: string; unblockHint?: { what: string; who: string } };
  /** Set when the Todo has opted out of every automatic start. */
  noAutoStart?: string;
  /** A dispatch override pinning its next attempt to an engine. */
  dispatchEngine?: string;
  sessions: { running: number; newest?: { employee: string | null; status: string; lastActivity: string } };
  links: LinkState[];
  /** The walk has already flagged this stuck episode. */
  flaggedStuck?: boolean;
}

export const truncate = (text: string | null | undefined, max: number): string | undefined => {
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated, ${text.length} chars]`;
};

/** When the Todo last changed status: its newest `status_change` event, or its creation. */
export function statusSince(item: WorkItem): string {
  const events = listWorkItemEvents(item.id);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "status_change" && events[i].toStatus === item.status) return events[i].createdAt;
  }
  return item.createdAt;
}

/** Why a Todo refuses every automatic start, or undefined. The dispatch
 *  config's `autoStart` is the one per-Todo opt-out; the `no-auto-start` label
 *  that once did the same is carried into it at boot (retired-opt-out-label.ts). */
export function noAutoStartReason(item: WorkItem): string | undefined {
  if (getTodoDispatchConfig(item.id)?.autoStart === false) return "autoStart is false";
  if (item.assignee === OPERATOR_ASSIGNEE) return "assigned to the operator";
  return todoHoldRefusal(item) ?? undefined;
}

const IN_FLIGHT = new Set<Session["status"]>(["running", "waiting"]);

export function sessionsOn(item: WorkItem): BoardTodo["sessions"] {
  const sessions = listSessionsByWorkItem(item.id);
  const newest = sessions[0];
  return {
    running: sessions.filter((session) => IN_FLIGHT.has(session.status)).length,
    ...(newest ? { newest: { employee: newest.employee ?? null, status: newest.status, lastActivity: newest.lastActivity } } : {}),
  };
}

export function stopOf(item: WorkItem): BoardTodo["stop"] {
  if (item.status !== "blocked") return undefined;
  const db = initDb();
  const cause = readStopCause(db, item.id);
  const block = readBlockRecord(db, item.id);
  const stop = { ...(block ? { blockKind: block.kind } : {}), ...(cause?.parkedUntil ? { parkedUntil: cause.parkedUntil } : {}), ...(cause?.unblockHint ? { unblockHint: cause.unblockHint } : {}) };
  return Object.keys(stop).length > 0 ? stop : undefined;
}

export interface DigestOptions {
  resolveLink: LinkResolver;
  /** Todo ids whose current stuck episode is already flagged. */
  flagged?: ReadonlySet<string>;
  now?: number;
}

/** Present keys only: an absent optional reads as absent, not as `undefined`. */
function optional<T extends object>(entries: { [K in keyof T]: T[K] | undefined | null | false | "" }): Partial<T> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "")) as Partial<T>;
}

/** One Todo with everything a gate can hang on, links resolved. */
export async function digestTodo(item: WorkItem, opts: DigestOptions): Promise<BoardTodo> {
  const labels = getWorkItemLabels(item.id).map((label) => label.name);
  const tail = commentsTail(item.id, COMMENTS_PER_TODO);
  const comments = tail.comments.filter((comment) => !comment.deletedAt)
    .map((comment) => ({ author: comment.author, authorKind: comment.authorKind, at: comment.createdAt, body: truncate(comment.body, COMMENT_CHARS) ?? "" }));
  const links = await Promise.all(
    findLinks([item.body, ...tail.comments.map((comment) => comment.body)], LINKS_PER_TODO)
      .map(({ url, kind }) => opts.resolveLink(url, kind)),
  );
  return {
    id: item.id,
    title: truncate(item.title.replace(/\s+/g, " ").trim(), TITLE_CHARS) ?? "",
    status: item.status,
    statusSince: statusSince(item),
    assignee: item.assignee,
    priority: item.priority,
    department: item.department,
    labels,
    parentId: item.parentId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    dueAt: item.dueAt,
    startAt: item.startAt,
    comments,
    commentsTotal: tail.total,
    relations: listRelations(item.id).map((relation) => ({ kind: relation.kind, direction: relation.direction, other: relation.other })),
    sessions: sessionsOn(item),
    links,
    ...optional<Pick<BoardTodo, "body" | "stop" | "noAutoStart" | "dispatchEngine" | "flaggedStuck" | "startHeld">>({
      startHeld: startDateHold(item, opts.now ?? Date.now()) !== undefined,
      body: truncate(item.body, BODY_CHARS),
      stop: stopOf(item),
      noAutoStart: noAutoStartReason(item),
      dispatchEngine: getTodoDispatchConfig(item.id)?.engine,
      flaggedStuck: opts.flagged?.has(item.id) === true,
    }),
  };
}

/** The open Todos, highest priority first, oldest first within a priority. */
export function listOpenTodos(): WorkItem[] {
  return OPEN_STATUSES.flatMap((status) => listWorkItems({ status }))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
