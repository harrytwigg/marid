/**
 * The talk session's HTTP half: open, keep alive, park, resume, close, and post
 * what a turn cost.
 *
 * `docs/talk-session-runtime.md` is the contract these routes implement.
 */
import { authFetch } from "@/lib/auth"
import type { RealtimeNoiseReduction } from "./opened-session"
import type { TalkUsage } from "./usage-delta"
import type { VisualCaptureReceipt } from "../context/visual-capture"
import { parseTalkControlManifest, type TalkControlManifest } from "./control-manifest"
import type { TalkUiEffect } from "./ui-effects"
import { browserInstanceId } from "../context/browser-instance"
import type { TalkScreenContext } from "../context/page-snapshot"
import { decodeGatewayEvent, type TalkProactiveCuePayload } from "@hundredfold/gateway-events"
import type { InterruptionTelemetry } from "./false-start-recovery"
import { parseOpenedSession } from "./opened-session"

export type TalkVadType = "server_vad" | "semantic_vad"

/** The gateway reaps a session after three missed beats (`TALK_SESSION_TTL_MS`,
 *  90s), so this is the slowest rate that keeps one alive. */
export const HEARTBEAT_INTERVAL_MS = 30_000

export interface OpenTalkSession {
  id: string
  browserInstanceId: string
  credentialGeneration: number
  /** The provider credential, minted for this open and never stored. */
  token: string
  /** Unix seconds. */
  expiresAt: number
  model: string
  /** The standing brief the gateway built for this instance. Empty when the
   *  gateway predates it, which the driver handles by sending page context
   *  alone. */
  brief: string
  manifest: TalkControlManifest
  topicMemory?: string
  vadType: TalkVadType
  noiseReduction: RealtimeNoiseReduction
}

export interface TalkToken {
  token: string
  expiresAt: number
  browserInstanceId: string
  credentialGeneration: number
  vadType?: TalkVadType
  noiseReduction?: RealtimeNoiseReduction
}

export interface ResumableTalkSession {
  id: string
  browserInstanceId: string
  credentialGeneration: number
  state: "live" | "parked"
  brief: string
  manifest: TalkControlManifest
  topicMemory?: string
  proactiveCues: TalkProactiveCuePayload[]
}

function proactiveCues(value: unknown): TalkProactiveCuePayload[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((payload) => {
    const frame = decodeGatewayEvent({ event: "talk:proactive-cue", payload })
    return frame?.event === "talk:proactive-cue" ? [frame.payload] : []
  })
}

function sessionPath(id: string, action?: string): string {
  const base = `/api/talk/sessions/${encodeURIComponent(id)}`
  return action ? `${base}/${action}` : base
}

/** What the gateway reports when voice has no provider it could use. It is a
 *  refusal with an answer, so callers offer setup rather than repeat a message —
 *  which is why it is a type and not a string to match against. */
export class VoiceUnconfiguredError extends Error {}

/** A durable candidate can legitimately disappear through expiry or start-over. */
export class TalkSessionMissingError extends Error {}

/** The gateway's own words for what went wrong, because it is the only party
 *  that knows whether voice is unconfigured, the provider refused, or the
 *  session is gone. A body with nothing to say falls back to the status. */
async function failure(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown; reason?: unknown }
    const message = typeof body.error === "string" && body.error ? body.error : null
    if (body.reason === "unconfigured") {
      return new VoiceUnconfiguredError(message ?? "Voice is not available.")
    }
    if (message) {
      if (response.status === 404) return new TalkSessionMissingError(message)
      return new Error(message)
    }
  } catch {
    /* a body that is not JSON says nothing the status does not */
  }
  const message = `The gateway answered ${response.status} for ${response.url || "the talk session"}.`
  return response.status === 404 ? new TalkSessionMissingError(message) : new Error(message)
}

async function talkFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authFetch(path, { method: "POST", ...init })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

function jsonBody(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

/**
 * Open a session. This is the call that mints a paid provider credential, so it
 * belongs to an operator gesture and nothing else — never a mount, never a
 * route change. `lib/talk-capability.ts` is what asks whether that is even
 * possible, and asking costs nothing.
 */
export async function openTalkSession(): Promise<OpenTalkSession> {
  // Noise reduction is not sent. It lives in `realtime.noiseReduction`, and the
  // browser used to override it with a localStorage copy that always had a
  // value — so the configured setting could never win, and the field in
  // config.yaml did nothing. The gateway decides; the response reports.
  const opened = await talkFetch<Partial<OpenTalkSession>>("/api/talk/sessions", jsonBody({
    browserInstanceId: browserInstanceId(),
  }))
  return parseOpenedSession(opened)
}

/** Inspect a candidate without minting a credential or touching the microphone. */
export async function getTalkSession(id: string): Promise<ResumableTalkSession> {
  const held = await talkFetch<Partial<ResumableTalkSession>>(sessionPath(id), { method: "GET" })
  const manifest = parseTalkControlManifest(held.manifest)
  if (
    held.id !== id
    || (held.state !== "live" && held.state !== "parked")
    || typeof held.browserInstanceId !== "string"
    || !Number.isInteger(held.credentialGeneration)
    || !manifest
  ) {
    throw new Error("The gateway returned an invalid resumable Talk session.")
  }
  return {
    id,
    browserInstanceId: held.browserInstanceId,
    credentialGeneration: held.credentialGeneration!,
    state: held.state,
    brief: held.brief ?? "",
    manifest,
    topicMemory: typeof held.topicMemory === "string" ? held.topicMemory : "",
    proactiveCues: proactiveCues(held.proactiveCues),
  }
}

export async function acknowledgeTalkProactiveCue(
  talkSessionId: string,
  receiptId: string,
  outcome: "completed" | "interrupted",
): Promise<void> {
  const path = `/api/talk/proactive/${encodeURIComponent(talkSessionId)}/ack`
  const request = jsonBody({ receiptId, outcome })
  try {
    await talkFetch(path, request)
  } catch (failure) {
    if (!(failure instanceof TypeError)) throw failure
    await talkFetch(path, request)
  }
}

export function postTalkScreenContext(
  id: string,
  screen: TalkScreenContext,
  browserId: string,
  credentialGeneration: number,
): Promise<void> {
  return talkFetch(sessionPath(id, "context"), jsonBody({
    browserInstanceId: browserId,
    credentialGeneration,
    screen,
  }))
}

export interface TalkControlCall {
  providerCallId: string
  providerItemId?: string
  providerEventId?: string
  providerTranscriptItemId?: string
  browserInstanceId?: string
  credentialGeneration?: number
  tool: string
  arguments: string
}

export type TalkControlResult =
  | { ok: true; verified: true; receiptId: string; replayed: boolean; operation: string; data: Record<string, unknown>; evidence: Record<string, unknown>; uiEffect: TalkUiEffect | null }
  | { ok: false; code: string; error: string }

export async function postTalkControlCall(id: string, call: TalkControlCall): Promise<TalkControlResult> {
  const request = jsonBody(call)
  try {
    return await talkFetch<TalkControlResult>(sessionPath(id, "control"), request)
  } catch (failure) {
    // A fetch-level failure cannot say whether the verified write committed.
    // Retry once with the same providerCallId; the gateway's durable receipt
    // turns that ambiguity into a replay instead of a duplicate mutation.
    if (!(failure instanceof TypeError)) throw failure
    return talkFetch<TalkControlResult>(sessionPath(id, "control"), request)
  }
}

export interface TalkTranscriptEvidence {
  browserInstanceId: string
  credentialGeneration: number
  providerItemId: string
  providerEventId: string
  transcript: string
}

export interface TalkTurnProviderEvidence {
  providerResponseId?: string
  providerItemId?: string
}

export function postTalkTranscript(id: string, evidence: TalkTranscriptEvidence): Promise<void> {
  return talkFetch(sessionPath(id, "transcript"), jsonBody(evidence))
}

/** `keepalive` because this is also what a closing tab sends, and an unload
 *  cancels ordinary requests in flight. Closing is idempotent server-side. */
export async function closeTalkSession(id: string): Promise<void> {
  await talkFetch(sessionPath(id), { method: "DELETE", keepalive: true })
}

export async function heartbeatTalkSession(id: string): Promise<void> {
  await talkFetch(sessionPath(id, "heartbeat"))
}

export async function parkTalkSession(id: string): Promise<void> {
  await talkFetch(sessionPath(id, "park"), { keepalive: true })
}

/** Resume returns a fresh credential, because the one the session was parked
 *  with expires within its 600 seconds. */
export async function resumeTalkSession(id: string): Promise<TalkToken> {
  const resumed = await talkFetch<TalkToken>(sessionPath(id, "resume"), jsonBody({}))
  return {
    token: resumed.token,
    expiresAt: resumed.expiresAt,
    browserInstanceId: resumed.browserInstanceId,
    credentialGeneration: resumed.credentialGeneration,
    ...(resumed.vadType ? { vadType: resumed.vadType } : {}),
    ...(resumed.noiseReduction ? { noiseReduction: resumed.noiseReduction } : {}),
  }
}

export function postTalkInterruption(id: string, event: InterruptionTelemetry): Promise<void> {
  return talkFetch(sessionPath(id, "interruptions"), jsonBody(event))
}

export async function postTalkTurn(
  id: string,
  usage: TalkUsage,
  transcript: string,
  visualReceipts: readonly VisualCaptureReceipt[] = [],
  providerEvidence: TalkTurnProviderEvidence = {},
): Promise<void> {
  await talkFetch(sessionPath(id, "turn"), jsonBody({
    usage,
    transcript,
    ...providerEvidence,
    ...(visualReceipts.length ? { visualReceipts } : {}),
  }))
}

export function startTalkHeartbeat(id: string): () => void {
  const timer = setInterval(() => {
    void heartbeatTalkSession(id).catch(() => {})
  }, HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(timer)
}
