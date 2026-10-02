/**
 * Self-compaction: a session compacting its own context mid-task and carrying
 * on, instead of dead-ending on "this session is getting long" until a human
 * starts a new one.
 *
 * The mechanism is two queued turns on the caller's own session, both put there
 * by the gateway while the turn that asked is still running:
 *
 *   1. a compaction turn — the engine's own native compaction, never a new
 *      mechanism: Claude Code's `/compact`, opencode's `session.summarize`;
 *   2. a resume turn — the handoff the agent wrote, delivered verbatim.
 *
 * Nothing compacts while the tool call is in flight. The session queue runs one
 * turn at a time, so both turns wait behind the one that asked; the tool returns
 * at once and the agent ends its turn. That is what makes the call survive the
 * compaction it requests: by the time the context is rewritten, the turn that
 * made the call has already ended and been recorded.
 *
 * The handoff is delivered as its own message AFTER the compaction rather than
 * folded into the compaction instructions, because a summary is lossy by design
 * and the handoff is exactly the part that must not be lost. The compaction
 * instructions carry only a one-line focus.
 */

/** How long after one self-compaction a session may request another. It
 *  de-duplicates a second call in the same turn and bounds a model that
 *  compacts, resumes and immediately compacts again to one cycle per window. */
export const SELF_COMPACTION_COOLDOWN_MS = 10 * 60_000;

/** Engines whose native compaction Jinn can drive. */
export const SELF_COMPACTION_ENGINES = ["claude", "opencode"] as const;

export interface CompactionHandoff {
  /** What the session is doing and why: the task, its Todo, the outcome wanted. */
  goal: string;
  /** What is finished, with where the evidence lives. */
  done: string;
  /** The exact next steps, in order. */
  next: string;
  /** Facts that must survive verbatim: ids, branches, paths, decisions, gotchas. */
  context?: string;
  /** Delegated sessions and sub-agents still in flight, and what each owes back. */
  waitingOn?: string;
}

/** Per-field caps. The whole handoff is re-read on every later turn of the
 *  session, so it is bounded like a prompt rather than like a document. */
export const HANDOFF_FIELD_MAX_CHARS: Record<keyof CompactionHandoff, number> = {
  goal: 1_000,
  done: 4_000,
  next: 4_000,
  context: 6_000,
  waitingOn: 2_000,
};

const REQUIRED_FIELDS = ["goal", "done", "next"] as const;
const OPTIONAL_FIELDS = ["context", "waitingOn"] as const;

export type HandoffParse = { ok: true; handoff: CompactionHandoff } | { ok: false; error: string };

type FieldParse = { ok: true; value?: string } | { ok: false; error: string };

function parseField(field: keyof CompactionHandoff, value: unknown, required: boolean): FieldParse {
  if (value === undefined || value === null) {
    return required
      ? { ok: false, error: `${field} is required: the post-compaction session reads the handoff instead of its history` }
      : { ok: true };
  }
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const text = value.trim();
  if (!text) {
    return required
      ? { ok: false, error: `${field} is empty — write what the session after compaction needs to know` }
      : { ok: true };
  }
  const max = HANDOFF_FIELD_MAX_CHARS[field];
  if (text.length > max) {
    return {
      ok: false,
      error: `${field} is ${text.length} characters, over its ${max}-character cap. `
        + "Keep the handoff to what the next turn needs; point at files or Todo comments for the rest.",
    };
  }
  return { ok: true, value: text };
}

/** Validate a caller-supplied handoff. Refuses rather than truncates: a handoff
 *  clipped without the author knowing is a handoff that silently lost its end. */
export function parseCompactionHandoff(body: unknown): HandoffParse {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const handoff: Partial<CompactionHandoff> = {};
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const parsed = parseField(field, raw[field], (REQUIRED_FIELDS as readonly string[]).includes(field));
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) handoff[field] = parsed.value;
  }
  return { ok: true, handoff: handoff as CompactionHandoff };
}

/** Why Jinn cannot drive an engine's native compaction, or undefined when it
 *  can. One rule for both ways in: a session's compact_session and an
 *  operator's `/compact` (see `compact-command.ts`). */
export type CompactionUnsupported = "opencode-run-mode" | "no-native-compaction";

export function compactionUnsupported(engine: string, opencodeMode: string | undefined): CompactionUnsupported | undefined {
  if (engine === "claude") return undefined;
  if (engine === "opencode") return opencodeMode === "server" ? undefined : "opencode-run-mode";
  return "no-native-compaction";
}

/** Whether an engine can compact, given the live opencode mode. Returns the
 *  caller-facing refusal otherwise. */
export function selfCompactionRefusal(engine: string, opencodeMode: string | undefined): string | undefined {
  switch (compactionUnsupported(engine, opencodeMode)) {
    case undefined:
      return undefined;
    case "opencode-run-mode":
      return "opencode sessions can only compact in server mode (engines.opencode.mode: server); this instance runs `opencode run`, which has no compaction Jinn can call";
    case "no-native-compaction":
      return `the ${engine} engine has no native compaction Jinn can drive; self-compaction supports ${SELF_COMPACTION_ENGINES.join(" and ")}`;
  }
}

export { isCompactCommand } from "../shared/skill-commands.js";

const FOCUS_MAX_CHARS = 300;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The compaction turn's prompt. One line, because it is pasted into Claude
 * Code's composer as a slash command, where a newline would submit early.
 */
/** How a self-compaction's `/compact` focus opens, so it can be told apart
 *  from one an operator typed. */
export const SELF_COMPACTION_FOCUS_PREFIX = "Self-compaction requested by this session mid-task.";

export function buildCompactCommand(handoff: Pick<CompactionHandoff, "goal">): string {
  return `/compact ${SELF_COMPACTION_FOCUS_PREFIX} `
    + "Keep the task and its goal, decisions made and why, exact identifiers "
    + "(Todo and session ids, branches, file paths, PRs), work delegated and still awaited, "
    + "and open problems. Drop raw tool output and superseded attempts. "
    + "The session's own handoff is re-delivered verbatim after this. "
    + `Current goal: ${oneLine(handoff.goal, FOCUS_MAX_CHARS)}`;
}

export const COMPACTION_TURN_DISPLAY = "🗜️ Compacting context — requested by this session";
/** Shown when the resume turn is QUEUED. The transcript records a queued turn's
 *  display text at that moment, not when the turn runs, so this must not claim
 *  the compaction is done: the measured "Context compacted: N → M" notice
 *  (`compactionConfirmation`) is the only one that says so. */
export const RESUME_TURN_DISPLAY = "🗜️ Handoff queued — this session resumes from it once the compaction has finished";

/** The resume turn: the handoff, verbatim, with the one instruction that turns
 *  it into a continuation rather than a message to answer. */
export function buildResumeMessage(handoff: CompactionHandoff): string {
  const sections = [
    "[Self-compaction resume] Your context was just compacted at your own request (compact_session). "
      + "Below is the handoff you wrote immediately before. It is exact where the summary is lossy, so prefer it "
      + "for what it says — but anything the summary shows happening after you wrote it is newer than it. "
      + "Resume the work now from \"Next\" — do not wait for another message, "
      + "and do not compact again straight away. If the compaction did not happen, you still have "
      + "your full context; carry on the same way.",
    `## Goal\n${handoff.goal}`,
    `## Done\n${handoff.done}`,
    `## Next\n${handoff.next}`,
  ];
  if (handoff.context) sections.push(`## Context\n${handoff.context}`);
  if (handoff.waitingOn) {
    sections.push(
      `## Waiting on\n${handoff.waitingOn}\n\n`
        + "Replies from these arrive as their own messages after this one and are expected. "
        + "To check on one sooner, read_session its session id.",
    );
  }
  return sections.join("\n\n");
}
