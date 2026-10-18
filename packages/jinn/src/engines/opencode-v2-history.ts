import { record, str, type V2Message } from "./opencode-v2-events.js";

/**
 * What an OpenCode 2 session's history says a Jinn turn must know before it
 * posts, and what Jinn keeps on the session for the next turn to say.
 *
 * Requests the operator cancelled in opencode's own terminal: the 1.x turn has
 * the long version of why (`cancelledRequests` in opencode-server-turn.ts): a
 * request stopped before it was answered stays in the history, and a model
 * reads the next prompt as a follow-up to it. OpenCode 2 keeps the same history
 * but says more about it. An execution (everything the session ran between two
 * idles) ends in an `idle` item that names its outcome, so a request was
 * cancelled exactly when it was delivered into an execution that ended
 * `interrupted`.
 *
 * Notes for the next turn: 2.x cannot change a message once it is delivered,
 * and an input queued for later is not passive context either (each delivered
 * input, a synthetic one included, gets a model step of its own; 2.0.29). So
 * what the next turn must tell the model (a Jinn prompt the user stopped, a
 * compaction that summarized the system prompt away) is kept in the session's
 * own metadata, under `jinn`, and the next turn puts it in front of its prompt.
 */

/** Metadata on every prompt Jinn posts; `notice` when it carried notes. */
export const JINN_V2_PROMPT_METADATA = { jinn: "prompt" } as const;

/** What Jinn keeps on a session for its next turn. */
export interface JinnSessionNotes {
  /** Jinn prompts the user stopped, oldest first. */
  stopped: string[];
  /** A compaction summarized the system prompt away: send it again. */
  reseed: boolean;
}

/** The notes in a session's metadata. */
export function jinnSessionNotes(metadata: Record<string, unknown> | undefined): JinnSessionNotes {
  const notes = record(metadata?.jinn);
  const stopped = Array.isArray(notes?.stopped) ? notes.stopped.filter((s): s is string => typeof s === "string") : [];
  return { stopped, reseed: notes?.reseed === true };
}

/** The session's metadata with these notes in place of its old ones (gone when
 *  there are none). Everything else in it is kept: a PATCH replaces it whole. */
export function withJinnSessionNotes(metadata: Record<string, unknown> | undefined, notes: JinnSessionNotes): Record<string, unknown> {
  const { jinn: _old, ...rest } = metadata ?? {};
  const kept = { ...(notes.stopped.length ? { stopped: notes.stopped } : {}), ...(notes.reseed ? { reseed: true } : {}) };
  return Object.keys(kept).length ? { ...rest, jinn: kept } : rest;
}

/** An item Jinn posted. */
export function isJinnItem(message: V2Message): boolean {
  return record(message.metadata)?.jinn !== undefined;
}

/** A Jinn prompt that carried notes: everything cancelled before it was named. */
function carriedNotice(message: V2Message): boolean {
  return message.type === "user" && record(message.metadata)?.notice === true;
}

/**
 * The operator's requests the history ends in that were cancelled, oldest
 * first, given the session's newest messages NEWEST FIRST (as
 * `GET /api/session/:id/message` lists them). Nothing while the session is
 * running: its newest execution has not ended yet. Walking back, execution by
 * execution:
 *
 * - one that ended other than `interrupted` ends the walk: what ran in it was
 *   answered, or failed some other way;
 * - in one that was interrupted, each request the operator sent is collected,
 *   and each Jinn item is stepped over (Jinn stops its own turns for reasons
 *   that are not the user's: a restart, a timeout, a new message);
 * - a Jinn prompt that carried a notice ends the walk: everything older was
 *   named there once, and the model still has it in front of it.
 */
export function cancelledV2Requests(newestFirst: V2Message[], sessionRunning: boolean): string[] {
  if (sessionRunning) return [];
  const found: string[] = [];
  let inExecution = false;
  for (const message of newestFirst) {
    if (message.type === "idle") {
      // An execution that ended any other way ends the walk.
      if (str(message.outcome) !== "interrupted") break;
      inExecution = true;
      continue;
    }
    // Anything newer than the newest idle has not run in an execution yet.
    if (!inExecution) continue;
    if (carriedNotice(message)) break;
    const text = operatorRequest(message);
    if (text) found.unshift(text);
  }
  return found;
}

/** What the operator asked in a user message; undefined for anything else. */
function operatorRequest(message: V2Message): string | undefined {
  if (message.type !== "user" || isJinnItem(message)) return undefined;
  return str(message.text)?.trim() || undefined;
}
