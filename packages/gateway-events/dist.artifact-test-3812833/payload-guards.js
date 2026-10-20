const deltaTypes = new Set([
    "text",
    "text_snapshot",
    "tool_use",
    "tool_result",
    "status",
    "error",
    "context",
    "block",
]);
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value) {
    return typeof value === "string";
}
function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isOptionalString(value) {
    return value === undefined || isString(value);
}
function isOptionalNumber(value) {
    return value === undefined || isNumber(value);
}
function isOptionalBoolean(value) {
    return value === undefined || typeof value === "boolean";
}
function isJsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (isNumber(value))
        return true;
    if (Array.isArray(value))
        return value.every(isJsonValue);
    return isRecord(value) && Object.values(value).every(isJsonValue);
}
function isEmptyPayload(value) {
    return isRecord(value) && Object.keys(value).length === 0;
}
function isNullableString(value) {
    return value === null || isString(value);
}
function isOptionalJsonObject(value) {
    return value === undefined || (isRecord(value) && isJsonValue(value));
}
function isDeltaType(value) {
    return isString(value) && deltaTypes.has(value);
}
function isSessionIdPayload(value) {
    return isRecord(value) && isString(value.sessionId);
}
function isMessageMedia(value) {
    return isRecord(value)
        && (value.type === "image" || value.type === "audio" || value.type === "video" || value.type === "file")
        && isString(value.url)
        && isOptionalString(value.name)
        && isOptionalString(value.mimeType)
        && isOptionalNumber(value.size);
}
function isTodoChange(value) {
    return isString(value.action)
        && isString(value.id)
        && isOptionalString(value.sessionId)
        && isNumber(value.version)
        && isOptionalJsonObject(value.value);
}
function isCompanyChangedEvent(value) {
    if (!isRecord(value))
        return false;
    switch (value.entity) {
        case "todo":
            return isTodoChange(value);
        case "sprint":
        case "department":
            return isString(value.action) && isString(value.id);
        default:
            return false;
    }
}
function isSessionCompleted(value) {
    return isRecord(value)
        && isString(value.sessionId)
        && isNullableString(value.result)
        && isNullableString(value.error)
        && isOptionalString(value.employee)
        && (value.title === undefined || isNullableString(value.title))
        && isOptionalNumber(value.cost)
        && isOptionalNumber(value.durationMs);
}
function isSessionDelta(value) {
    return isRecord(value)
        && isString(value.sessionId)
        && isDeltaType(value.type)
        && isString(value.content)
        && hasOptionalDeltaToolFields(value)
        && (value.block === undefined || isJsonValue(value.block));
}
function hasOptionalDeltaToolFields(value) {
    return isOptionalString(value.toolName)
        && isOptionalString(value.toolId)
        && isOptionalString(value.activityReceiptId)
        && isOptionalString(value.agentId)
        && isOptionalString(value.input)
        && isOptionalBoolean(value.sidechain);
}
function isSessionAttachment(value) {
    return isRecord(value)
        && isString(value.sessionId)
        && isString(value.id)
        && isString(value.content)
        && Array.isArray(value.media)
        && value.media.every(isMessageMedia)
        && isNumber(value.timestamp);
}
function isSessionBackground(value) {
    if (!isRecord(value) || !isString(value.sessionId) || !isString(value.transportState))
        return false;
    if (!isOptionalString(value.status))
        return false;
    return value.backgroundActivity === null || isBackgroundActivity(value.backgroundActivity);
}
function isBackgroundActivity(value) {
    return isRecord(value)
        && isNumber(value.activeStreams)
        && isOptionalNumber(value.activeAgents)
        && isOptionalNumber(value.activeMonitors)
        && isOptionalNumber(value.backgroundAgents)
        && isOptionalBoolean(value.backgroundRerun)
        && isString(value.lastActivityAt);
}
function isProgressPayload(value) {
    return isRecord(value) && isNumber(value.progress);
}
function isErrorPayload(value) {
    return isRecord(value) && isString(value.error);
}
function isBoundedString(value, limit) {
    return isString(value) && value.length > 0 && value.length <= limit;
}
function isProactiveEffect(value) {
    if (value === null)
        return true;
    if (!isRecord(value))
        return false;
    return ["refresh", "highlight"].includes(String(value.type)) && isBoundedString(value.target, 500);
}
function isProactiveCue(value) {
    if (!isRecord(value))
        return false;
    return [
        isBoundedString(value.receiptId, 200),
        isBoundedString(value.talkSessionId, 200),
        value.topicId === null ? true : isBoundedString(value.topicId, 200),
        ["quiet", "spoken"].includes(String(value.disposition)),
        ["routine", "urgent"].includes(String(value.urgency)),
        isBoundedString(value.summary, 500),
        isProactiveEffect(value.uiEffect),
    ].every(Boolean);
}
/**
 * One guard per event, keyed by name. `Record<GatewayEventName, …>` is what
 * keeps the set exhaustive: adding an event to `GatewayEventMap` without a
 * guard for it fails to compile.
 */
export const payloadGuards = {
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
    "session:notification": (value) => isRecord(value) && isString(value.sessionId) && isString(value.message) && isOptionalJsonObject(value.meta),
    "session:attachment": isSessionAttachment,
    "session:background": isSessionBackground,
    "queue:updated": (value) => isRecord(value)
        && isString(value.sessionId)
        && isString(value.sessionKey)
        && isOptionalNumber(value.depth)
        && isOptionalBoolean(value.paused),
    "hooks:run": (value) => isRecord(value) && isString(value.id) && isString(value.hook) && isString(value.status),
    "company:changed": isCompanyChangedEvent,
    "pins:changed": isEmptyPayload,
    "notes:changed": (value) => isRecord(value)
        && isString(value.path)
        && isString(value.revision)
        && (value.action === "created" || value.action === "updated"),
    "todo-capture:stage": (value) => isRecord(value)
        && isString(value.captureId)
        && isString(value.stage)
        && (value.workItemId === null || isString(value.workItemId)),
    "org:changed": isEmptyPayload,
    "config:reloaded": isEmptyPayload,
    "skills:changed": isEmptyPayload,
    "plugins:changed": isEmptyPayload,
    "plugin:notice": (value) => isRecord(value)
        && isString(value.pluginId)
        && isString(value.message)
        && (value.level === "info" || value.level === "warning" || value.level === "error"),
    "cron:reloaded": isEmptyPayload,
    "cron:run-finished": (value) => isRecord(value) && isString(value.jobId) && (value.status === "success" || value.status === "error"),
    "engines:updated": isEmptyPayload,
    "stt:download:progress": isProgressPayload,
    "stt:download:complete": (value) => isRecord(value) && isString(value.model),
    "stt:download:error": isErrorPayload,
    "talk:audio": (value) => isRecord(value)
        && isString(value.sessionId)
        && isNumber(value.seq)
        && isString(value.mime)
        && isString(value.dataBase64)
        && isOptionalBoolean(value.last),
    "talk:tts:download:progress": isProgressPayload,
    "talk:tts:download:complete": isEmptyPayload,
    "talk:tts:download:error": isErrorPayload,
    "talk:proactive-cue": isProactiveCue,
};
//# sourceMappingURL=payload-guards.js.map