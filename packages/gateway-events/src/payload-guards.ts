/** The runtime half of the event protocol: one guard per event name, checking an
 *  untrusted frame's payload against the shape ./index.js declares for it. Kept
 *  beside the map rather than in it so the protocol reads as a list of events. */
import type { GatewayEventMap, GatewayEventName } from "./index.js"
import type { CompanyChangedEvent, JsonValue, MessageMediaWire } from "./payloads.js"

type WireRecord = Record<string, unknown>

const deltaTypes = new Set<GatewayEventMap["session:delta"]["type"]>([
  "text",
  "text_snapshot",
  "tool_use",
  "tool_result",
  "status",
  "error",
  "context",
  "block",
])

export function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value)
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (isNumber(value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isOptionalJsonObject(value: unknown): boolean {
  return value === undefined || (isRecord(value) && isJsonValue(value))
}

function isDeltaType(value: unknown): value is GatewayEventMap["session:delta"]["type"] {
  return isString(value) && deltaTypes.has(value as GatewayEventMap["session:delta"]["type"])
}

function isSessionIdPayload(value: unknown): value is { sessionId: string } {
  return isRecord(value) && isString(value.sessionId)
}

function isMessageMedia(value: unknown): value is MessageMediaWire {
  return isRecord(value)
    && (value.type === "image" || value.type === "audio" || value.type === "video" || value.type === "file")
    && isString(value.url)
    && isOptionalString(value.name)
    && isOptionalString(value.mimeType)
    && isOptionalNumber(value.size)
}

function isTodoChange(value: WireRecord): boolean {
  return isString(value.action)
    && isString(value.id)
    && isOptionalString(value.sessionId)
    && isNumber(value.version)
    && isOptionalJsonObject(value.value)
}

function isCompanyChangedEvent(value: unknown): value is CompanyChangedEvent {
  if (!isRecord(value)) return false
  switch (value.entity) {
    case "todo":
      return isTodoChange(value)
    case "workflow-definition":
      return isString(value.id) && isNumber(value.revision)
    case "workflow-run":
      return isString(value.workflowId) && isString(value.runId)
    default:
      return false
  }
}

function isSessionCompleted(value: unknown): boolean {
  return isRecord(value)
    && isString(value.sessionId)
    && isNullableString(value.result)
    && isNullableString(value.error)
    && isOptionalString(value.employee)
    && (value.title === undefined || isNullableString(value.title))
    && isOptionalNumber(value.cost)
    && isOptionalNumber(value.durationMs)
}

function isSessionDelta(value: unknown): boolean {
  return isRecord(value)
    && isString(value.sessionId)
    && isDeltaType(value.type)
    && isString(value.content)
    && isOptionalString(value.toolName)
    && isOptionalString(value.toolId)
    && isOptionalString(value.activityReceiptId)
    && isOptionalString(value.input)
    && (value.block === undefined || isJsonValue(value.block))
}

function isSessionAttachment(value: unknown): boolean {
  return isRecord(value)
    && isString(value.sessionId)
    && isString(value.id)
    && isString(value.content)
    && Array.isArray(value.media)
    && value.media.every(isMessageMedia)
    && isNumber(value.timestamp)
}

function isSessionBackground(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.sessionId) || !isString(value.transportState)) return false
  if (value.backgroundActivity === null) return true
  return isRecord(value.backgroundActivity)
    && isNumber(value.backgroundActivity.activeStreams)
    && isOptionalNumber(value.backgroundActivity.activeAgents)
    && isOptionalNumber(value.backgroundActivity.activeMonitors)
    && isString(value.backgroundActivity.lastActivityAt)
}

function isProgressPayload(value: unknown): boolean {
  return isRecord(value) && isNumber(value.progress)
}

function isErrorPayload(value: unknown): boolean {
  return isRecord(value) && isString(value.error)
}

function isBoundedString(value: unknown, limit: number): boolean {
  return isString(value) && value.length > 0 && value.length <= limit
}

function isProactiveEffect(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value)) return false
  return ["refresh", "highlight"].includes(String(value.type)) && isBoundedString(value.target, 500)
}

function isProactiveCue(value: unknown): boolean {
  if (!isRecord(value)) return false
  return [
    isBoundedString(value.receiptId, 200),
    isBoundedString(value.talkSessionId, 200),
    value.topicId === null ? true : isBoundedString(value.topicId, 200),
    ["quiet", "spoken"].includes(String(value.disposition)),
    ["routine", "urgent"].includes(String(value.urgency)),
    isBoundedString(value.summary, 500),
    isProactiveEffect(value.uiEffect),
  ].every(Boolean)
}

type PayloadGuard = (value: unknown) => boolean

/**
 * One guard per event, keyed by name. `Record<GatewayEventName, …>` is what
 * keeps the set exhaustive: adding an event to `GatewayEventMap` without a
 * guard for it fails to compile.
 */
export const payloadGuards: Record<GatewayEventName, PayloadGuard> = {
  "session:started": isSessionIdPayload,
  "session:created": isSessionIdPayload,
  "session:updated": (value) => isRecord(value) && isString(value.sessionId) && isOptionalString(value.title),
  "session:deleted": isSessionIdPayload,
  "session:stopped": isSessionIdPayload,
  "session:external-turn": isSessionIdPayload,
  "session:terminal-wait": (value) => isRecord(value) && isString(value.sessionId) && typeof value.waiting === "boolean",
  "session:interrupted": (value) => isRecord(value) && isString(value.sessionId) && isString(value.reason),
  "session:completed": isSessionCompleted,
  "session:delta": isSessionDelta,
  "session:notification": (value) =>
    isRecord(value) && isString(value.sessionId) && isString(value.message) && isOptionalJsonObject(value.meta),
  "session:attachment": isSessionAttachment,
  "session:background": isSessionBackground,
  "queue:updated": (value) =>
    isRecord(value)
      && isString(value.sessionId)
      && isString(value.sessionKey)
      && isOptionalNumber(value.depth)
      && isOptionalBoolean(value.paused),
  "company:changed": isCompanyChangedEvent,
  "pins:changed": isEmptyPayload,
  "notes:changed": (value) =>
    isRecord(value)
      && isString(value.path)
      && isString(value.revision)
      && (value.action === "created" || value.action === "updated"),
  "todo-capture:stage": (value) =>
    isRecord(value)
      && isString(value.captureId)
      && isString(value.stage)
      && (value.workItemId === null || isString(value.workItemId)),
  "org:changed": isEmptyPayload,
  "config:reloaded": isEmptyPayload,
  "skills:changed": isEmptyPayload,
  "plugins:changed": isEmptyPayload,
  "plugin:notice": (value) =>
    isRecord(value)
      && isString(value.pluginId)
      && isString(value.message)
      && (value.level === "info" || value.level === "warning" || value.level === "error"),
  "cron:reloaded": isEmptyPayload,
  "cron:run-finished": (value) =>
    isRecord(value) && isString(value.jobId) && (value.status === "success" || value.status === "error"),
  "engines:updated": isEmptyPayload,
  "stt:download:progress": isProgressPayload,
  "stt:download:complete": (value) => isRecord(value) && isString(value.model),
  "stt:download:error": isErrorPayload,
  "talk:audio": (value) =>
    isRecord(value)
      && isString(value.sessionId)
      && isNumber(value.seq)
      && isString(value.mime)
      && isString(value.dataBase64)
      && isOptionalBoolean(value.last),
  "talk:tts:download:progress": isProgressPayload,
  "talk:tts:download:complete": isEmptyPayload,
  "talk:tts:download:error": isErrorPayload,
  "talk:proactive-cue": isProactiveCue,
}
