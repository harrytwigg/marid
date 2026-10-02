import { initDb } from "../shared/db.js";
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

/**
 * The board as the walk reads it: every open Todo with what its gates could
 * hang on — text, comments, relations and the status of what they point at,
 * dates, the stop cause, linked GitHub PRs and issues with their real state,
 * and whether anything is running on it.
 *
 * Open means `backlog`, `blocked` and `executing`. `in_review` is the operator's
 * desk and `done`/`cancelled` are closed; the walk touches none of them.
 * Text is truncated so a board of long Todos still fits one prompt.
 */

export const OPEN_STATUSES: readonly WorkItemStatus[] = ["backlog", "blocked", "executing"];
/** The opt-out label every automatic start honours. */
export const NO_AUTO_START_LABEL = "no-auto-start";

const BODY_CHARS = 2000;
const ACCEPTANCE_CHARS = 1000;
const COMMENT_CHARS = 600;
const COMMENTS_PER_TODO = 6;
const DEFAULT_MAX_TODOS = 150;
/** The board's share of one prompt, in characters of JSON. Todos past it are
 *  left out (lowest priority, newest first) and counted in `omitted`. */
const DEFAULT_MAX_BOARD_CHARS = 120_000;
/** GitHub lookups in flight at once. */
const LINK_CONCURRENCY = 6;

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
  body?: string;
  acceptance?: string;
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

export interface BoardDigest {
  todos: BoardTodo[];
  /** Open Todos left out because the board is bigger than one prompt holds. */
  omitted: number;
  inReview: number;
}

const truncate = (text: string | null | undefined, max: number): string | undefined => {
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

/** Why a Todo refuses every automatic start, or undefined. */
export function noAutoStartReason(item: WorkItem, labels?: string[]): string | undefined {
  const names = labels ?? getWorkItemLabels(item.id).map((label) => label.name);
  if (names.includes(NO_AUTO_START_LABEL)) return `label ${NO_AUTO_START_LABEL}`;
  if (getTodoDispatchConfig(item.id)?.autoStart === false) return "autoStart is false";
  if (item.assignee === OPERATOR_ASSIGNEE) return "assigned to the operator";
  return undefined;
}

const IN_FLIGHT = new Set<Session["status"]>(["running", "waiting"]);

function sessionsOn(item: WorkItem): BoardTodo["sessions"] {
  const sessions = listSessionsByWorkItem(item.id);
  const newest = sessions[0];
  return {
    running: sessions.filter((session) => IN_FLIGHT.has(session.status)).length,
    ...(newest ? { newest: { employee: newest.employee ?? null, status: newest.status, lastActivity: newest.lastActivity } } : {}),
  };
}

function stopOf(item: WorkItem): BoardTodo["stop"] {
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
  maxTodos?: number;
  maxChars?: number;
}

/** Map with at most `limit` calls in flight, results in input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Present keys only: an absent optional reads as absent, not as `undefined`. */
function optional<T extends object>(entries: { [K in keyof T]: T[K] | undefined | null | false | "" }): Partial<T> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "")) as Partial<T>;
}

async function digestTodo(item: WorkItem, opts: DigestOptions): Promise<BoardTodo> {
  const labels = getWorkItemLabels(item.id).map((label) => label.name);
  const tail = commentsTail(item.id, COMMENTS_PER_TODO);
  const comments = tail.comments.filter((comment) => !comment.deletedAt)
    .map((comment) => ({ author: comment.author, authorKind: comment.authorKind, at: comment.createdAt, body: truncate(comment.body, COMMENT_CHARS) ?? "" }));
  const links = await Promise.all(
    findLinks([item.body, item.acceptance, ...tail.comments.map((comment) => comment.body)])
      .map(({ url, kind }) => opts.resolveLink(url, kind)),
  );
  return {
    id: item.id,
    title: item.title,
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
    comments,
    commentsTotal: tail.total,
    relations: listRelations(item.id).map((relation) => ({ kind: relation.kind, direction: relation.direction, other: relation.other })),
    sessions: sessionsOn(item),
    links,
    ...optional<Pick<BoardTodo, "body" | "acceptance" | "stop" | "noAutoStart" | "dispatchEngine" | "flaggedStuck">>({
      body: truncate(item.body, BODY_CHARS),
      acceptance: truncate(item.acceptance, ACCEPTANCE_CHARS),
      stop: stopOf(item),
      noAutoStart: noAutoStartReason(item, labels),
      dispatchEngine: getTodoDispatchConfig(item.id)?.engine,
      flaggedStuck: opts.flagged?.has(item.id) === true,
    }),
  };
}

export async function buildBoardDigest(opts: DigestOptions): Promise<BoardDigest> {
  const open = OPEN_STATUSES.flatMap((status) => listWorkItems({ status }))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const candidates = open.slice(0, opts.maxTodos ?? DEFAULT_MAX_TODOS);
  // Links are resolved concurrently and bounded, so an offline `gh` costs one
  // timeout per batch rather than one per link, one Todo at a time.
  const digests = await mapLimited(candidates, LINK_CONCURRENCY, (item) => digestTodo(item, opts));
  const budget = opts.maxChars ?? DEFAULT_MAX_BOARD_CHARS;
  const todos: BoardTodo[] = [];
  let used = 0;
  for (const digest of digests) {
    const size = JSON.stringify(digest).length;
    if (used + size > budget && todos.length > 0) break;
    todos.push(digest);
    used += size;
  }
  return { todos, omitted: open.length - todos.length, inReview: listWorkItems({ status: "in_review" }).length };
}
