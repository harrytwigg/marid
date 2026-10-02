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
 *
 * The prompt gets each Todo as a short block of plain text (renderTodo), not
 * as JSON: the same facts in a fraction of the space, with no quoting or
 * escaping between the model and the Todo's own words. Every part of a Todo is
 * capped, so one Todo stays a few kilobytes however long its thread, and the
 * board as a whole is cut to the prompt's byte budget (fitBoard).
 */

export const OPEN_STATUSES: readonly WorkItemStatus[] = ["backlog", "blocked", "executing"];
/** The opt-out label every automatic start honours. */
export const NO_AUTO_START_LABEL = "no-auto-start";

const TITLE_CHARS = 200;
const BODY_CHARS = 1200;
const COMMENT_CHARS = 400;
const COMMENTS_PER_TODO = 4;
const RELATIONS_SHOWN = 8;
const LINKS_PER_TODO = 6;
/** A related Todo's or a link's title, beside its id or URL. */
const REF_TITLE_CHARS = 80;
const DEFAULT_MAX_TODOS = 150;
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
  /** The open Todos, highest priority first, oldest first within a priority. */
  todos: BoardTodo[];
  /** Open Todos past the digest's count cap, left out before any were read. */
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
    comments,
    commentsTotal: tail.total,
    relations: listRelations(item.id).map((relation) => ({ kind: relation.kind, direction: relation.direction, other: relation.other })),
    sessions: sessionsOn(item),
    links,
    ...optional<Pick<BoardTodo, "body" | "stop" | "noAutoStart" | "dispatchEngine" | "flaggedStuck">>({
      body: truncate(item.body, BODY_CHARS),
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
  const todos = await mapLimited(candidates, LINK_CONCURRENCY, (item) => digestTodo(item, opts));
  return { todos, omitted: open.length - todos.length, inReview: listWorkItems({ status: "in_review" }).length };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** An ISO timestamp to the minute: `2026-10-02T14:48:15.286Z` → `2026-10-02T14:48Z`. */
const minute = (iso: string): string => iso.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/, "$1Z");
const oneLine = (text: string, max: number): string => truncate(text.replace(/\s+/g, " ").trim(), max) ?? "";
/** The Todo's own words, indented under their label so no line of theirs can
 *  read as the start of another Todo. */
const quoted = (text: string, prefix: string): string[] => text.split(/\r?\n/).map((line) => `${prefix}${line}`.trimEnd());

const RELATION_VERBS: Record<string, { out: string; in: string }> = {
  blocks: { out: "blocks", in: "blocked by" },
  duplicates: { out: "duplicates", in: "duplicated by" },
  relates: { out: "relates to", in: "relates to" },
};

function relationLine(relation: BoardTodo["relations"][number]): string {
  const verb = RELATION_VERBS[relation.kind]?.[relation.direction] ?? `${relation.kind} (${relation.direction})`;
  return `${verb} ${relation.other.id} (${relation.other.status}): ${oneLine(relation.other.title, REF_TITLE_CHARS)}`;
}

function linkLine(link: LinkState): string {
  const when = link.mergedAt ? ` at ${minute(link.mergedAt)}` : link.closedAt ? ` at ${minute(link.closedAt)}` : "";
  const why = link.error ? ` (${oneLine(link.error, REF_TITLE_CHARS)})` : "";
  const title = link.title ? `: ${oneLine(link.title, REF_TITLE_CHARS)}` : "";
  return `${link.kind === "pull" ? "pull request" : "issue"} ${link.url} is ${link.state}${when}${why}${title}`;
}

function stopLine(stop: NonNullable<BoardTodo["stop"]>): string {
  return [
    stop.blockKind ? `block kind ${stop.blockKind}` : undefined,
    stop.parkedUntil ? `parked until ${minute(stop.parkedUntil)}` : undefined,
    stop.unblockHint ? `waiting on ${oneLine(stop.unblockHint.what, REF_TITLE_CHARS)} from ${oneLine(stop.unblockHint.who, REF_TITLE_CHARS)}` : undefined,
  ].filter(Boolean).join(" · ");
}

function sessionsLine(sessions: BoardTodo["sessions"]): string | undefined {
  if (sessions.running === 0 && !sessions.newest) return undefined;
  const newest = sessions.newest
    ? `; newest by ${sessions.newest.employee ?? "no employee"}, ${sessions.newest.status}, last active ${minute(sessions.newest.lastActivity)}`
    : "";
  return `sessions: ${sessions.running} running${newest}`;
}

/** The facts the walk's rules hang on, one labelled line each. */
function factLines(todo: BoardTodo): string[] {
  const lines = [
    [
      `status ${todo.status} since ${minute(todo.statusSince)}`,
      `priority ${todo.priority}`,
      `assignee ${todo.assignee ?? "none"}`,
      todo.department ? `department ${todo.department}` : undefined,
      todo.parentId ? `parent ${todo.parentId}` : undefined,
    ].filter(Boolean).join(" · "),
    [`created ${minute(todo.createdAt)}`, `updated ${minute(todo.updatedAt)}`, todo.dueAt ? `due ${minute(todo.dueAt)}` : undefined].filter(Boolean).join(" · "),
  ];
  const optionalLines = [
    todo.labels.length > 0 ? `labels: ${todo.labels.join(", ")}` : undefined,
    todo.stop ? `stopped: ${stopLine(todo.stop)}` : undefined,
    todo.noAutoStart ? `no auto-start: ${todo.noAutoStart}` : undefined,
    todo.dispatchEngine ? `dispatch engine: ${todo.dispatchEngine}` : undefined,
    todo.flaggedStuck ? "already flagged stuck: yes, this episode" : undefined,
    sessionsLine(todo.sessions),
  ];
  return [...lines, ...optionalLines.filter((line): line is string => line !== undefined)];
}

/** What the Todo points at: related Todos and linked GitHub items. */
function referenceLines(todo: BoardTodo): string[] {
  const lines = todo.relations.slice(0, RELATIONS_SHOWN).map((relation) => `relation: ${relationLine(relation)}`);
  if (todo.relations.length > RELATIONS_SHOWN) lines.push(`relation: … ${todo.relations.length - RELATIONS_SHOWN} more not shown`);
  return [...lines, ...todo.links.map((link) => `link: ${linkLine(link)}`)];
}

/** The Todo's own words: its body and newest comments, quoted. */
function threadLines(todo: BoardTodo): string[] {
  const lines = todo.body ? ["body:", ...quoted(todo.body, "  ")] : [];
  if (todo.comments.length === 0) return lines;
  lines.push(`comments (newest ${todo.comments.length} of ${todo.commentsTotal}, oldest first):`);
  for (const comment of todo.comments) {
    lines.push(`  - ${comment.author} (${comment.authorKind}) at ${minute(comment.at)}:`, ...quoted(comment.body, "    "));
  }
  return lines;
}

/** One Todo as the walk's prompt shows it: a `### <id>: <title>` heading, then
 *  one labelled line per fact, then its body and newest comments, quoted. */
export function renderTodo(todo: BoardTodo): string {
  return [`### ${todo.id}: ${todo.title}`, ...factLines(todo), ...referenceLines(todo), ...threadLines(todo)].join("\n");
}

export interface FittedBoard {
  /** The Todos shown, in board order. */
  shown: BoardTodo[];
  /** Their rendered blocks, one blank line apart. */
  text: string;
}

/** As many of the board's Todos as fit `budgetBytes` of UTF-8, in board order:
 *  the cut falls on the lowest priority, newest first. The first Todo is always
 *  shown, so a tick over a non-empty board never asks about nothing. */
export function fitBoard(todos: readonly BoardTodo[], budgetBytes: number): FittedBoard {
  const shown: BoardTodo[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const todo of todos) {
    const block = renderTodo(todo);
    const size = Buffer.byteLength(block, "utf8") + 2;
    if (used + size > budgetBytes && shown.length > 0) break;
    shown.push(todo);
    blocks.push(block);
    used += size;
  }
  return { shown, text: blocks.join("\n\n") };
}
