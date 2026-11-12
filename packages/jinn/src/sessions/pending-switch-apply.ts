import type { GatewayEmit } from "../shared/gateway-events.js";
import type { JinnConfig, JsonObject, Session } from "../shared/types.js";
import { leftTranscriptOf } from "./left-transcript.js";
import { PENDING_SWITCH_KEY, type PendingSwitch } from "./pending-switch.js";
import { switchSessionTarget, updateSessionForAttempt } from "./registry.js";
import { recordSwitchNotice, type LastSwitch } from "./switch-notice.js";
import { switchResumePrompt, type ResumeCarryOver } from "./switch-resume-prompt.js";
import { ownSwitchTarget, resolveSwitchTarget, type SwitchRequest, type SwitchTargetView } from "./switch-target.js";

/**
 * Applying a session's own switch when its resume turn starts. By then the compaction has
 * settled, so its outcome (or its absence) is on the pending switch. Runs inside the resume's
 * attempt, so the write is fenced on that attempt and leaves the status `running`: the turn's
 * own settle still lands. Every path ends the pending switch, writes `lastSwitch`, tells the
 * transcript, and returns the prompt the resume runs with.
 */

export interface ApplyEnvironment {
  config: JinnConfig;
  emit: GatewayEmit;
}

export interface AppliedSwitch {
  /** The message the resume turn runs with, in place of the payload it was queued with. */
  prompt: string;
  /** The row after the write. */
  session: Session;
  /** Whether the session moved. False: it stays where it was and the notice says why. */
  applied: boolean;
}

/** Whether the session still runs where the request found it: the engine, profile, model and effort the request was judged against. */
function stillOn(own: SwitchTargetView, from: SwitchTargetView): boolean {
  return own.engine === from.engine
    && own.claudeConfigDir === from.claudeConfigDir
    && own.model === from.model
    && own.effortLevel === from.effortLevel;
}

/** The request to re-resolve for the target the session asked for: the same engine, profile and model, as the request spelt them. */
function requestFor(to: SwitchTargetView): SwitchRequest {
  const profile = to.engine !== "claude" ? undefined : (to.claudeConfigDir === null ? "" : (to.profile ?? undefined));
  return { engine: to.engine, profile, model: to.model ?? undefined, effortLevel: to.effortLevel ?? undefined };
}

/** The target to apply, or why the switch no longer can happen: the session moved meanwhile, or the target is no longer one it may move to. */
function resolveForApply(config: JinnConfig, session: Session, pending: PendingSwitch): { ok: true; target: SwitchTargetView } | { ok: false; reason: string } {
  if (!stillOn(ownSwitchTarget(config, session), pending.from)) return { ok: false, reason: "the session was moved to another target meanwhile" };
  const resolved = resolveSwitchTarget(config, session, requestFor(pending.to), { caller: "session" });
  return resolved.ok ? { ok: true, target: resolved.target } : { ok: false, reason: resolved.error };
}

/** What carried the conversation over, from how the compaction ended. */
function carryFor(pending: PendingSwitch): { carry: ResumeCarryOver; carryOver: LastSwitch["carryOver"]; reason?: string } {
  const outcome = pending.compaction;
  const failure = pending.compactionQueued ? (outcome && !outcome.ok ? outcome.reason : "no-outcome") : "not-supported";
  if (pending.conversation === "same") {
    return outcome?.ok ? { carry: { kind: "same-conversation" }, carryOver: "same-conversation" } : { carry: { kind: "same-conversation", failure }, carryOver: "same-conversation", reason: failure };
  }
  if (outcome?.ok && outcome.summary.trim()) return { carry: { kind: "summary", summary: outcome.summary }, carryOver: "summary" };
  return { carry: { kind: "manual-handover", failure }, carryOver: "manual-handover", reason: failure };
}

function lastSwitchOf(pending: PendingSwitch, target: SwitchTargetView, carried: ReturnType<typeof carryFor>, leftTranscript: string | undefined): LastSwitch {
  return {
    at: new Date().toISOString(),
    by: "session",
    from: pending.from,
    to: target,
    applied: true,
    carryOver: carried.carryOver,
    ...(pending.compactedOn && pending.compactedOn !== pending.from.engine ? { compactedOn: pending.compactedOn } : {}),
    ...(carried.reason ? { reason: carried.reason } : {}),
    ...(leftTranscript ? { leftTranscript } : {}),
  };
}

function finish(env: ApplyEnvironment, sessionId: string, last: LastSwitch): void {
  recordSwitchNotice(sessionId, env.emit, env.config, last);
  env.emit("session:updated", { sessionId });
}

/** The switch did not happen: the pending record goes, `lastSwitch` says why, and the resume tells the session it stayed. */
function declineSwitch(env: ApplyEnvironment, session: Session, pending: PendingSwitch, attemptToken: string, reason: string): AppliedSwitch | undefined {
  const own = ownSwitchTarget(env.config, session);
  const last: LastSwitch = {
    at: new Date().toISOString(),
    by: "session",
    from: own,
    to: pending.to,
    applied: false,
    carryOver: pending.conversation === "same" ? "same-conversation" : "manual-handover",
    reason,
  };
  const written = updateSessionForAttempt(session.id, attemptToken, (current) => {
    const { [PENDING_SWITCH_KEY]: _gone, ...rest } = current.transportMeta ?? {};
    return { transportMeta: { ...rest, lastSwitch: last as unknown as JsonObject } };
  });
  if (!written) return undefined;
  finish(env, session.id, last);
  // A compaction that ran but left no usable summary did compact the context.
  const outcome = pending.compaction;
  const compacted = pending.compactionQueued && outcome !== undefined && (outcome.ok || outcome.reason === "no-summary" || outcome.reason === "summary-too-long");
  const prompt = switchResumePrompt({
    config: env.config, sessionId: session.id, target: pending.to, current: own, fromEngine: pending.compactedOn ?? own.engine, handoff: pending.handoff,
    carry: { kind: "not-applied", reason, compacted },
  });
  return { prompt, session: written, applied: false };
}

/**
 * Apply `pending` for the resume turn running as `attemptToken`. Undefined when the write was
 * refused because the attempt is no longer the session's (a stop or a newer turn took it): the
 * turn then runs as it was queued and the stale attempt's own settle decides the rest.
 */
export function applyPendingSwitch(env: ApplyEnvironment, session: Session, pending: PendingSwitch, attemptToken: string): AppliedSwitch | undefined {
  const resolved = resolveForApply(env.config, session, pending);
  if (!resolved.ok) return declineSwitch(env, session, pending, attemptToken, resolved.reason);
  const { target } = resolved;
  const carried = carryFor(pending);
  // Read while the row still names the left conversation: the write below moves it.
  const leftTranscript = pending.conversation === "new" ? leftTranscriptOf(session, env.config) : undefined;
  const last = lastSwitchOf(pending, target, carried, leftTranscript);
  const switched = switchSessionTarget(session.id, {
    engine: target.engine,
    ...(target.engine === "claude" ? { claudeConfigDir: target.claudeConfigDir } : {}),
    model: target.model,
    effortLevel: target.effortLevel,
    leftConversation: pending.conversation === "new" ? "retire" : "park",
    freshTarget: pending.conversation === "new",
    sync: "none",
    lastSwitch: last as unknown as JsonObject,
  }, { attemptToken });
  if (!switched) return undefined;
  finish(env, session.id, last);
  const prompt = switchResumePrompt({
    config: env.config, sessionId: session.id, target, current: pending.from, fromEngine: pending.compactedOn ?? pending.from.engine, handoff: pending.handoff,
    carry: carried.carry, leftTranscript,
  });
  return { prompt, session: switched, applied: true };
}
