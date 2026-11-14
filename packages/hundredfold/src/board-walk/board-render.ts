import type { WorkItem } from "../work-items/store.js";
import type { LinkState } from "./pr-state.js";
import { noAutoStartReason, sessionsOn, statusSince, stopOf, truncate, type BoardTodo } from "./board.js";
import { startDateHold } from "../work-items/start-date.js";

/**
 * The board as text for the walk's model: one line per Todo for going through
 * the board (boardLine), and one Todo in full (renderTodo). Plain labelled
 * lines rather than JSON: the same facts in a fraction of the space, with no
 * quoting or escaping between the model and the Todo's own words.
 */

const RELATIONS_SHOWN = 8;
/** A related Todo's or a link's title, beside its id or URL. */
const REF_TITLE_CHARS = 80;

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

function datesLine(todo: BoardTodo): string {
  const dates = [`created ${minute(todo.createdAt)}`, `updated ${minute(todo.updatedAt)}`];
  if (todo.startAt) dates.push(`starts ${minute(todo.startAt)}${todo.startHeld ? " (holds it: not started before then)" : ""}`);
  if (todo.dueAt) dates.push(`due ${minute(todo.dueAt)}`);
  return dates.join(" · ");
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
    datesLine(todo),
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

/** One open Todo as a single line: enough to go through the board, and to
 *  leave alone a Todo that plainly has nothing to decide, without reading it
 *  in full. `decided` is what this tick already did with it. */
export function boardLine(item: WorkItem, opts: { flagged: boolean; decided?: string; now: number }): string {
  const stop = stopOf(item);
  const sessions = sessionsOn(item);
  const optOut = noAutoStartReason(item);
  return [
    `${item.id}: ${oneLine(item.title, REF_TITLE_CHARS)}`,
    `${item.status} since ${minute(statusSince(item))}`,
    `priority ${item.priority}`,
    `assignee ${item.assignee ?? "none"}`,
    `updated ${minute(item.updatedAt)}`,
    stop ? `stopped: ${stopLine(stop)}` : undefined,
    optOut ? `no auto-start (${optOut})` : undefined,
    startDateHold(item, opts.now) ? `not before its start date ${minute(item.startAt!)}` : undefined,
    sessions.running > 0 ? `${sessions.running} session${sessions.running === 1 ? "" : "s"} running` : undefined,
    opts.flagged ? "already flagged stuck" : undefined,
    opts.decided ? `DECIDED this tick: ${opts.decided}` : undefined,
  ].filter(Boolean).join(" · ");
}
