import type { IncomingMessage, ServerResponse } from "node:http";
import type { TalkControlRuntime } from "../talk/control/runtime.js";
import { operationByName } from "../talk/control/manifest.js";
import type { TalkControlFailure, TalkControlManifest } from "../talk/control/types.js";
import type { TalkSessionRegistry } from "../talk/session/registry.js";
import { insertTalkMessage } from "../sessions/talk-message-store.js";
import { updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import { readJsonBody } from "./http-helpers.js";
import type { CallerIdentity } from "./session-comm-guards.js";

interface ControlBody {
  providerCallId: string;
  providerItemId?: string;
  providerEventId?: string;
  providerTranscriptItemId?: string;
  browserInstanceId?: string;
  credentialGeneration?: number;
  tool: string;
  arguments: string;
}

interface TalkControlApiOptions {
  caller: CallerIdentity;
  manifest: TalkControlManifest;
  registry: TalkSessionRegistry;
  runtime: TalkControlRuntime | undefined;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

function bodyProblem(body: Record<string, unknown>): string | null {
  const required = [body.providerCallId, body.tool, body.arguments];
  if (!required.every((value) => typeof value === "string")) return "providerCallId, tool, and arguments are required strings.";
  const optional = ["providerItemId", "providerEventId", "providerTranscriptItemId"];
  const invalid = optional.find((key) => body[key] !== undefined && typeof body[key] !== "string");
  return invalid ? `${invalid} must be a string when present.` : null;
}

function controlBody(body: Record<string, unknown>): ControlBody {
  return Object.fromEntries(Object.entries({
    providerCallId: body.providerCallId, providerItemId: body.providerItemId,
    providerEventId: body.providerEventId, providerTranscriptItemId: body.providerTranscriptItemId,
    browserInstanceId: typeof body.browserInstanceId === "string" ? body.browserInstanceId : undefined,
    credentialGeneration: Number.isInteger(body.credentialGeneration) ? Number(body.credentialGeneration) : undefined,
    tool: body.tool, arguments: body.arguments,
  }).filter((entry) => entry[1] !== undefined)) as unknown as ControlBody;
}

async function readControlBody(
  req: IncomingMessage,
  res: ServerResponse,
  send: TalkControlApiOptions["send"],
): Promise<ControlBody | null> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return null;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const problem = bodyProblem(body);
  if (!problem) return controlBody(body);
  send(res, 400, { error: problem });
  return null;
}

/**
 * Writes that reach past this browser, and so must be bound to the credential
 * generation the live orb was opened with — not merely posted with the
 * operator's token. `operator-evidence.ts` states the same contract adapter-side.
 */
const BOUND_CREDENTIAL_OPERATIONS = new Set([
  "talk_send_to_session",
]);

function boundCredentialMatches(body: ControlBody, session: ReturnType<TalkSessionRegistry["get"]>): boolean {
  if (!session) return false;
  return !BOUND_CREDENTIAL_OPERATIONS.has(body.tool)
    || (body.browserInstanceId === session.browserInstanceId && body.credentialGeneration === session.credentialGeneration);
}

function auditVerifiedControl(
  id: string,
  body: ControlBody,
  result: Awaited<ReturnType<TalkControlRuntime["dispatch"]>>,
  options: TalkControlApiOptions,
): void {
  const operation = operationByName(options.manifest, body.tool);
  if (!result.ok || result.replayed || operation?.mutability !== "write") return;
  const args = JSON.parse(body.arguments) as Record<string, unknown>;
  options.registry.recordAction(id, {
    tool: operation.name,
    subject: typeof args.id === "string" ? args.id : null,
    lane: "fast",
    consent: "not-required",
  });
}

/**
 * One server line per dispatch, whatever the outcome.
 *
 * The file logged nothing at all, so a Talk write that never landed left no
 * trace anyone could search for — the failure this route exists to make
 * audible. A failure is a warning because it is what someone greps for.
 */
function logControlOutcome(
  talkSessionId: string,
  body: ControlBody,
  result: Awaited<ReturnType<TalkControlRuntime["dispatch"]>>,
): void {
  const where = `${body.tool} on talk session ${talkSessionId} (provider call ${body.providerCallId})`;
  if (result.ok) {
    logger.info(`talk control ok: ${where}${result.replayed ? " — replayed" : ""}`);
    return;
  }
  logger.warn(`talk control failed: ${where} — ${result.code}: ${result.error}`);
}

/**
 * The transcript row, for a failure as much as for a receipt.
 *
 * Writing successes only meant the session store agreed with the model that
 * nothing had been attempted. The two rows carry different identities so a
 * retry that succeeds is recorded next to the attempt that did not.
 */
function recordControlOutcome(
  sessionId: string,
  body: ControlBody,
  result: Awaited<ReturnType<TalkControlRuntime["dispatch"]>>,
): void {
  const message = insertTalkMessage({
    sessionId,
    role: "assistant",
    content: result.ok ? `Completed ${result.operation}.` : `Couldn't ${body.tool}: ${result.error}`,
    identity: result.ok ? `control:${body.providerCallId}` : `control-failure:${body.providerCallId}`,
    toolCall: result.ok ? result.operation : body.tool,
    toolId: body.providerCallId,
    meta: { talk: result.ok
      ? { kind: "control-receipt", receiptId: result.receiptId, verified: true, operation: result.operation }
      : { kind: "control-failure", verified: false, operation: body.tool, code: result.code, reason: result.error } },
  });
  if (message.created) updateSession(sessionId, { lastActivity: new Date().toISOString() });
}

export async function handleTalkControl(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  options: TalkControlApiOptions,
): Promise<void> {
  options.registry.heartbeat(id);
  if (!options.runtime) {
    options.send(res, 404, { error: `Talk session ${id} does not have an active control runtime.` });
    return;
  }
  const body = await readControlBody(req, res, options.send);
  if (!body) return;
  const session = options.registry.get(id);
  if (!boundCredentialMatches(body, session)) {
    const result: TalkControlFailure = {
      ok: false,
      code: "credential-mismatch",
      error: "The control call does not match the active browser credential generation.",
    };
    logControlOutcome(id, body, result);
    if (session) recordControlOutcome(session.sessionId, body, result);
    options.send(res, 409, result);
    return;
  }
  const result = await options.runtime.dispatch({ talkSessionId: id, ...body, caller: options.caller });
  auditVerifiedControl(id, body, result, options);
  logControlOutcome(id, body, result);
  if (session) recordControlOutcome(session.sessionId, body, result);
  options.send(res, 200, result);
}
