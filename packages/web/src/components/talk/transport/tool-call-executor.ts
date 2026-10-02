import { createVisualCapture, type VisualCaptureReceipt } from "../context/visual-capture"
import { executeBrowserToolCall } from "../tools/browser-tool-executor"
import type { RealtimeFrame } from "./realtime-events"
import { postTalkControlCall, type TalkControlCall, type TalkControlResult } from "./session-client"
import { operationByName, type TalkControlManifest } from "./control-manifest"
import { applyTalkUiEffect, type TalkUiEffect } from "./ui-effects"
import { runVisualToolRequest } from "./visual-tool-request"

interface TalkToolExecutionOptions {
  sessionId: string
  browserInstanceId?: string
  credentialGeneration?: number
  operatorTranscript?: { itemId: string; eventId: string; persisted: Promise<void> } | null
  manifest: TalkControlManifest
  requestKey: string | null
  capture: ReturnType<typeof createVisualCapture>
  receipts: VisualCaptureReceipt[]
  send: (event: Record<string, unknown>) => void
  applyUiEffect?: (effect: TalkUiEffect | null) => Promise<void>
}

/** Operations the gateway will only accept bound to the operator's own live
 *  utterance. Posting one without that identity is refused there, so it is
 *  refused here too rather than sent to fail. */
const BOUND_EVIDENCE_OPERATIONS = new Set(["talk_send_to_session"])
const APPLIED_EFFECT_LIMIT = 500
const appliedEffects = new Set<string>()

async function applyVerifiedEffect(
  options: TalkToolExecutionOptions,
  result: Extract<Awaited<ReturnType<typeof postTalkControlCall>>, { ok: true }>,
): Promise<void> {
  if (!result.uiEffect) return
  const key = `${options.sessionId}:${result.receiptId}`
  if (appliedEffects.has(key)) return
  appliedEffects.add(key)
  if (appliedEffects.size > APPLIED_EFFECT_LIMIT) appliedEffects.delete(appliedEffects.values().next().value!)
  try {
    await (options.applyUiEffect ?? applyTalkUiEffect)(result.uiEffect)
  } catch (failure) {
    appliedEffects.delete(key)
    throw failure
  }
}

function gatewayCall(call: Extract<RealtimeFrame, { type: "tool_call" }>, options: TalkToolExecutionOptions) {
  return Object.fromEntries(Object.entries({
    providerCallId: call.callId,
    providerItemId: call.itemId,
    providerEventId: call.eventId,
    providerTranscriptItemId: options.operatorTranscript?.itemId,
    browserInstanceId: options.browserInstanceId,
    credentialGeneration: options.credentialGeneration,
    tool: call.name,
    arguments: call.arguments,
  }).filter((entry) => entry[1] !== undefined)) as unknown as TalkControlCall
}

/**
 * The transport's own words for a control that never reached the gateway.
 *
 * A stopped gateway and a refused operation are different facts, and the
 * operator can only hear the difference if the reason survives the catch.
 */
function transportReason(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error ?? "").trim()
  return message
    ? `The Talk control could not reach the gateway: ${message}`
    : "The Talk control could not reach the gateway."
}

/**
 * The gateway's answer, or an honest failure when the body is not one.
 *
 * `postTalkControlCall` returns whatever JSON came back. A body that does not
 * say whether it succeeded used to reach the model verbatim — an empty object
 * reads as neither success nor failure, which is the mute shape this feature
 * exists to remove.
 */
function gatewayAnswer(body: TalkControlResult, tool: string): TalkControlResult {
  return body && typeof body === "object" && typeof (body as { ok?: unknown }).ok === "boolean"
    ? body
    : { ok: false, code: "malformed-answer", error: `The gateway's answer to ${tool} did not say whether it succeeded.` }
}

async function executeGatewayTool(
  call: Extract<RealtimeFrame, { type: "tool_call" }>,
  options: TalkToolExecutionOptions,
): Promise<Record<string, unknown>> {
  const hasBoundIdentity = [options.browserInstanceId, options.credentialGeneration, options.operatorTranscript].every(Boolean)
  if (BOUND_EVIDENCE_OPERATIONS.has(call.name) && !hasBoundIdentity) {
    return { ok: false, code: "credential-missing", error: "The active Talk credential identity is missing." }
  }
  let body: TalkControlResult
  try {
    // Persisting the operator's utterance is part of reaching the gateway, so
    // it is inside the guard: with the gateway down it fails first, and left
    // outside it surfaced as a bare "Failed to fetch" with no subject.
    if (options.operatorTranscript) await options.operatorTranscript.persisted
    body = await postTalkControlCall(options.sessionId, gatewayCall(call, options))
  } catch (failure) {
    return { ok: false, code: "transport-failed", error: transportReason(failure) }
  }
  const result = gatewayAnswer(body, call.name)
  if (result.ok) await applyVerifiedEffect(options, result)
  return result
}

export async function executeTalkTool(
  call: Extract<RealtimeFrame, { type: "tool_call" }>,
  options: TalkToolExecutionOptions,
): Promise<Record<string, unknown>> {
  const operation = operationByName(options.manifest, call.name)
  // An unknown name is reported to the gateway rather than refused here in
  // silence. The gateway owns the manifest, so it either knows an operation
  // this client's copy predates, or it records the rejection with a log line
  // and a transcript row — the trace whose absence made a failed Talk write
  // look like nothing had ever been attempted.
  if (!operation || operation.target === "gateway") return executeGatewayTool(call, options)
  if (call.name === "capture_current_view") {
    return runVisualToolRequest({
      arguments: call.arguments,
      requestKey: options.requestKey,
      capture: options.capture,
      send: options.send,
      receipts: options.receipts,
    })
  }
  return executeBrowserToolCall(call.name, call.arguments)
}
