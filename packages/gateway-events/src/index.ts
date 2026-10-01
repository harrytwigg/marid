/** The gateway → browser event protocol: the event map, its names, and the runtime that
 *  decodes a frame. The JSON-only shapes those events carry live in ./payloads.js,
 *  and the per-event payload guards in ./payload-guards.js. */
import type { CompanyChangedEvent, JsonObject, JsonValue, MessageMediaWire, TalkProactiveCuePayload } from "./payloads.js"
export type * from "./payloads.js"

export interface GatewayEventMap {
  "session:started": { sessionId: string }
  "session:created": { sessionId: string }
  "session:updated": { sessionId: string; title?: string }
  "session:deleted": { sessionId: string }
  "session:stopped": { sessionId: string }
  "session:external-turn": { sessionId: string }
  /** A gateway turn started (true) or stopped (false) waiting for a turn the
   *  operator typed into the claude terminal to finish. */
  "session:terminal-wait": { sessionId: string; waiting: boolean }
  "session:interrupted": { sessionId: string; reason: string }
  "session:completed": {
    sessionId: string
    result: string | null
    error: string | null
    employee?: string
    title?: string | null
    cost?: number
    durationMs?: number
  }
  "session:delta": {
    sessionId: string
    type: "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block"
    content: string
    toolName?: string
    toolId?: string
    activityReceiptId?: string
    input?: string
    block?: JsonValue
  }
  "session:notification": { sessionId: string; message: string; meta?: JsonObject }
  "session:attachment": { sessionId: string; id: string; content: string; media: MessageMediaWire[]; timestamp: number }
  "session:background": {
    sessionId: string
    transportState: string
    backgroundActivity: {
      activeStreams: number
      activeAgents?: number
      activeMonitors?: number
      lastActivityAt: string
    } | null
  }
  "queue:updated": { sessionId: string; sessionKey: string; depth?: number; paused?: boolean }
  "company:changed": CompanyChangedEvent
  "pins:changed": Record<string, never>
  "notes:changed": { path: string; revision: string; action: "created" | "updated" }
  /** A quick capture moved. The payload is a nudge, not the truth: the browser
   *  re-reads GET /api/todo-captures/:id, which DERIVES the stage from real
   *  state, so a reload recovers and no stage can be shown before its fact. */
  "todo-capture:stage": { captureId: string; stage: string; workItemId: string | null }
  "org:changed": Record<string, never>
  "config:reloaded": Record<string, never>
  "skills:changed": Record<string, never>
  "plugins:changed": Record<string, never>
  /** One plugin's backend asking the dashboard to say something. The browser
   *  half of the same plugin can call `host.notify` directly; a backend has no
   *  DOM, so this frame is how the two halves reach one notification surface. */
  "plugin:notice": { pluginId: string; message: string; level: "info" | "warning" | "error" }
  "cron:reloaded": Record<string, never>
  "cron:run-finished": { jobId: string; status: "success" | "error" }
  "engines:updated": Record<string, never>
  "stt:download:progress": { progress: number }
  "stt:download:complete": { model: string }
  "stt:download:error": { error: string }
  "talk:audio": { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
  "talk:tts:download:progress": { progress: number }
  "talk:tts:download:complete": Record<string, never>
  "talk:tts:download:error": { error: string }
  "talk:proactive-cue": TalkProactiveCuePayload
}

export type GatewayEventName = keyof GatewayEventMap
export type GatewayEvent = {
  [K in GatewayEventName]: { event: K; payload: GatewayEventMap[K] }
}[GatewayEventName]
export type GatewayEventListener = (frame: GatewayEvent) => void
export type GatewayEmit = <K extends GatewayEventName>(event: K, payload: GatewayEventMap[K]) => void

export const GATEWAY_EVENTS = {
  sessionStarted: "session:started",
  sessionCreated: "session:created",
  sessionUpdated: "session:updated",
  sessionDeleted: "session:deleted",
  sessionStopped: "session:stopped",
  sessionExternalTurn: "session:external-turn",
  sessionTerminalWait: "session:terminal-wait",
  sessionInterrupted: "session:interrupted",
  sessionCompleted: "session:completed",
  sessionDelta: "session:delta",
  sessionNotification: "session:notification",
  sessionAttachment: "session:attachment",
  sessionBackground: "session:background",
  queueUpdated: "queue:updated",
  companyChanged: "company:changed",
  pinsChanged: "pins:changed",
  notesChanged: "notes:changed",
  todoCaptureStage: "todo-capture:stage",
  orgChanged: "org:changed",
  configReloaded: "config:reloaded",
  skillsChanged: "skills:changed",
  pluginsChanged: "plugins:changed",
  pluginNotice: "plugin:notice",
  cronReloaded: "cron:reloaded",
  cronRunFinished: "cron:run-finished",
  enginesUpdated: "engines:updated",
  sttDownloadProgress: "stt:download:progress",
  sttDownloadComplete: "stt:download:complete",
  sttDownloadError: "stt:download:error",
  talkAudio: "talk:audio",
  talkTtsDownloadProgress: "talk:tts:download:progress",
  talkTtsDownloadComplete: "talk:tts:download:complete",
  talkTtsDownloadError: "talk:tts:download:error",
  talkProactiveCue: "talk:proactive-cue",
} as const satisfies Record<string, GatewayEventName>

const gatewayEventNames = new Set<string>(Object.values(GATEWAY_EVENTS))

export function isGatewayEventName(value: unknown): value is GatewayEventName {
  return typeof value === "string" && gatewayEventNames.has(value)
}

import { isRecord, payloadGuards } from "./payload-guards.js"

/** Decode an untrusted websocket frame into the shared discriminated union. */
export function decodeGatewayEvent(value: unknown): GatewayEvent | null {
  if (!isRecord(value) || !isGatewayEventName(value.event)) return null
  if (!payloadGuards[value.event](value.payload)) return null
  return value as GatewayEvent
}

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  return decodeGatewayEvent(value) !== null
}
