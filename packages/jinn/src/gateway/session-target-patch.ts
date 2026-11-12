import { findSessionTranscript } from "../engines/claude-transcript-path.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import type { JinnConfig, JsonObject, Session } from "../shared/types.js";
import { getEngineSessionRef, getSession, switchSessionTarget } from "../sessions/registry.js";
import { sessionClaudeProfile } from "../sessions/session-account.js";
import { transcriptCwd } from "../sessions/session-cwd.js";
import { sessionScopeDepartment } from "../sessions/session-scope.js";
import { recordSwitchNotice, type LastSwitch } from "../sessions/switch-notice.js";
import { claudeAccountFor, resolveSwitchTarget, type SwitchTargetView } from "../sessions/switch-target.js";
import { orgRegistry } from "./org-registry.js";

/**
 * The operator's switch of an existing session's engine or Claude profile
 * (`PUT|PATCH /api/sessions/:id`): resolve the target, refuse while a turn is in flight,
 * write it through `switchSessionTarget` with a history pointer, and record the switch.
 * The route keeps everything else (title, fallback fields, model/effort without a move).
 */

/** The `profile` field: a declared account's name, or null (the session's own login). Undefined when absent. */
export function parseProfileField(raw: unknown): { ok: true; profile: string | null | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, profile: raw };
  if (typeof raw !== "string") return { ok: false, error: "profile must be a string, or null for the session's own login" };
  return { ok: true, profile: raw.trim() };
}

export type TargetPatchResult =
  | { kind: "none" }
  | { kind: "refused"; error: string }
  | { kind: "switched"; session: Session };

export interface TargetPatchInput {
  session: Session;
  config: JinnConfig;
  emit: GatewayEmit;
  body: { engine?: string; profile?: string | null; model?: unknown; effortLevel?: unknown };
  /** A turn is running, waiting or queued: nothing may move the session meanwhile. */
  busy: boolean;
}

/** The left Claude conversation's transcript path, found while the row still names it; none for a scoped or remote session or one with no conversation yet. */
function leftTranscriptOf(session: Session, config: JinnConfig): string | undefined {
  if (session.engine !== "claude" || sessionScopeDepartment(session)) return undefined;
  const employee = session.employee ? orgRegistry(config).get(session.employee) : undefined;
  if (isRemoteTarget(employee)) return undefined;
  const id = getEngineSessionRef(session, "claude").id;
  return id ? findSessionTranscript(id, sessionClaudeProfile(session, employee), transcriptCwd(session)) : undefined;
}

/** Whether the target leaves the session in the conversation slot it is in: nothing to switch, today's model/effort path. */
function staysInSlot(config: JinnConfig, session: Session, target: SwitchTargetView): boolean {
  if (target.engine !== session.engine) return false;
  return target.engine !== "claude" || claudeAccountFor(config, session, target.claudeConfigDir) === claudeAccountFor(config, session, session.claudeConfigDir);
}

/** The record of an operator's switch, with the left transcript read while the row still names it. */
function operatorSwitchRecord(session: Session, config: JinnConfig, own: SwitchTargetView, target: SwitchTargetView): LastSwitch {
  const leftTranscript = leftTranscriptOf(session, config);
  return {
    at: new Date().toISOString(),
    by: "operator",
    from: own,
    to: target,
    applied: true,
    carryOver: "transcript-pointer",
    ...(leftTranscript ? { leftTranscript } : {}),
  };
}

/**
 * The switch a PUT/PATCH asks for, if it asks for one. `none` when the request names no
 * engine or profile that moves the session (the route then handles model/effort as before).
 */
export function patchSessionTarget(input: TargetPatchInput): TargetPatchResult {
  const { session, config, body } = input;
  if ((body.engine === undefined || body.engine === session.engine) && body.profile === undefined) return { kind: "none" };

  const resolved = resolveSwitchTarget(config, session, body, { caller: "operator" });
  if (!resolved.ok) return { kind: "refused", error: resolved.error };
  const { target, own } = resolved;
  if (staysInSlot(config, session, target)) return { kind: "none" };
  if (input.busy) return { kind: "refused", error: "Cannot switch engine or profile while a turn is running, waiting, or queued" };

  const lastSwitch = operatorSwitchRecord(session, config, own, target);
  const switched = switchSessionTarget(session.id, {
    engine: target.engine,
    ...(body.profile !== undefined ? { claudeConfigDir: target.claudeConfigDir } : {}),
    model: target.model,
    effortLevel: target.effortLevel,
    leftConversation: "park",
    sync: "pointer",
    lastSwitch: lastSwitch as unknown as JsonObject,
  });
  if (!switched) return { kind: "refused", error: "session not found" };
  recordSwitchNotice(session.id, input.emit, config, lastSwitch);
  return { kind: "switched", session: getSession(session.id) ?? switched };
}
