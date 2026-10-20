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
    hooksRun: "hooks:run",
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
};
const gatewayEventNames = new Set(Object.values(GATEWAY_EVENTS));
export function isGatewayEventName(value) {
    return typeof value === "string" && gatewayEventNames.has(value);
}
import { isRecord, payloadGuards } from "./payload-guards.js";
/** Decode an untrusted websocket frame into the shared discriminated union. */
export function decodeGatewayEvent(value) {
    if (!isRecord(value) || !isGatewayEventName(value.event))
        return null;
    if (!payloadGuards[value.event](value.payload))
        return null;
    return value;
}
export function isGatewayEvent(value) {
    return decodeGatewayEvent(value) !== null;
}
//# sourceMappingURL=index.js.map