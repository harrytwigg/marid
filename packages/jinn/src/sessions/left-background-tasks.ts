import type { BackgroundTaskWait } from "../shared/session-waits.js";
import type { Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getSession, updateSession } from "./registry.js";

/**
 * Background tasks a session started and its engine process ended under with
 * nobody told: the session was stopped, or the gateway chose not to start a
 * turn to say so. Claude Code only announces a background task's end while its
 * process lives, so once the process is gone that announcement never comes.
 * The record rides on the session until its next explicit turn, which carries
 * a note naming each task, then drops them.
 */
export const LEFT_BACKGROUND_TASKS_META_KEY = "leftBackgroundTasks";

/** Why nobody was told at the time: the session was stopped on purpose, or the
 *  gateway did not start the turn that would have told it. */
export type LeftBackgroundReason = "stopped" | "not-nudged";

/** The slice of a task the note names. */
export type LeftBackgroundTask = Pick<BackgroundTaskWait, "id" | "kind" | "command" | "description" | "agentType">;

type LeftBackgroundEntry = LeftBackgroundTask & { reason: LeftBackgroundReason; at: string };

/** Past this many, the oldest are dropped: a stuck client, not a plausible count. */
const MAX_LEFT_BACKGROUND_TASKS = 20;

const KIND_LABELS: Record<LeftBackgroundTask["kind"], string> = {
  process: "background Bash",
  monitor: "Monitor",
  subagent: "background sub-agent",
};

/** One bullet naming a task: its id and kind, what it was for, and what it ran. */
export function describeBackgroundTask(task: LeftBackgroundTask): string {
  const what = task.kind === "subagent" ? task.agentType : task.command;
  const parts = [
    `${task.id} (${KIND_LABELS[task.kind]})`,
    ...(task.description ? [task.description] : []),
    ...(what ? [`\`${what}\``] : []),
  ];
  return `- ${parts.join(": ")}`;
}

function entryFrom(value: unknown): LeftBackgroundEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = (key: string): string | null => (typeof row[key] === "string" && row[key] ? row[key] as string : null);
  const kind = text("kind");
  const id = text("id");
  if (!id || (kind !== "process" && kind !== "monitor" && kind !== "subagent")) return null;
  return {
    id, kind, command: text("command"), description: text("description"), agentType: text("agentType"),
    reason: row.reason === "stopped" ? "stopped" : "not-nudged", at: text("at") ?? "",
  };
}

/** The tasks the session is still owed a word about, oldest first. */
export function readLeftBackgroundTasks(session: Pick<Session, "transportMeta">): LeftBackgroundEntry[] {
  const held = session.transportMeta?.[LEFT_BACKGROUND_TASKS_META_KEY];
  if (!Array.isArray(held)) return [];
  return held.map(entryFrom).filter((entry): entry is LeftBackgroundEntry => entry !== null);
}

/**
 * Keep tasks a session's next turn should hear of. Recorded once per task id:
 * a task reported again (the same loss seen twice) replaces its entry.
 */
export function recordLeftBackgroundTasks(
  sessionId: string,
  tasks: readonly LeftBackgroundTask[],
  reason: LeftBackgroundReason,
  now = new Date(),
): boolean {
  const session = getSession(sessionId);
  if (!session || tasks.length === 0) return false;
  const incoming = tasks.map((task): LeftBackgroundEntry => ({
    id: task.id, kind: task.kind, command: task.command, description: task.description, agentType: task.agentType,
    reason, at: now.toISOString(),
  }));
  const ids = new Set(incoming.map((entry) => entry.id));
  const pending = [...readLeftBackgroundTasks(session).filter((entry) => !ids.has(entry.id)), ...incoming]
    .slice(-MAX_LEFT_BACKGROUND_TASKS);
  const base = session.transportMeta && typeof session.transportMeta === "object" && !Array.isArray(session.transportMeta)
    ? session.transportMeta
    : {};
  updateSession(sessionId, { transportMeta: { ...base, [LEFT_BACKGROUND_TASKS_META_KEY]: pending } });
  logger.info(`[left-background-tasks] ${sessionId}: kept ${incoming.length} task(s) for its next turn (${reason}): ${incoming.map((entry) => entry.id).join(", ")}`);
  return true;
}

/** The note a turn leads with: what was left behind and what to do about it. */
export function leftBackgroundTasksNote(entries: readonly LeftBackgroundEntry[]): string {
  const one = entries.length === 1;
  const stopped = entries.every((entry) => entry.reason === "stopped");
  return [
    `[Gateway] ${one ? "A background task" : `${entries.length} background tasks`} this session started ${one ? "was" : "were"} still running `
      + `when its engine process ended${stopped ? " (the session was stopped)" : ""}. `
      + `${one ? "Its" : "Their"} completion notification will never arrive and ${one ? "its" : "their"} output may be partial or missing. Task ids:`,
    ...entries.map(describeBackgroundTask),
    `Check ${one ? "its" : "each one's"} outcome directly (output, files or service touched), re-run what is still needed, `
      + "then deal with the message below.",
  ].join("\n");
}

/** What a turn owes the session about left-behind tasks: the prompt with the note ahead of it, and the ids it
 *  carried, which settle drops once the engine has read them. No tasks owed leaves the prompt alone. */
export function withLeftBackgroundTasksNote(
  session: Pick<Session, "transportMeta">,
  prompt: string,
): { promptToRun: string; carriedLeftBackgroundTaskIds: string[] } {
  const entries = readLeftBackgroundTasks(session);
  if (entries.length === 0) return { promptToRun: prompt, carriedLeftBackgroundTaskIds: [] };
  const note = leftBackgroundTasksNote(entries);
  return {
    promptToRun: prompt.trim() ? `${note}\n\n${prompt}` : note,
    carriedLeftBackgroundTaskIds: entries.map((entry) => entry.id),
  };
}

/** A resolved prompt with the note about tasks left behind ahead of it, and the ids carried. */
export function withLeftBackgroundNote<T extends { promptToRun: string }>(
  session: Pick<Session, "transportMeta">,
  resolved: T,
): T & { carriedLeftBackgroundTaskIds: string[] } {
  return { ...resolved, ...withLeftBackgroundTasksNote(session, resolved.promptToRun) };
}

/** The session's meta without the tasks a turn has now put in front of the engine. Tasks recorded after that turn
 *  composed its prompt are not in `ids` and stay owed. */
export function withLeftBackgroundTasksCleared(meta: unknown, ids: readonly string[]): Record<string, unknown> {
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  const carried = new Set(ids);
  const left = readLeftBackgroundTasks({ transportMeta: base as Session["transportMeta"] }).filter((entry) => !carried.has(entry.id));
  if (left.length > 0) base[LEFT_BACKGROUND_TASKS_META_KEY] = left;
  else delete base[LEFT_BACKGROUND_TASKS_META_KEY];
  return base;
}
