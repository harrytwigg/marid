/** The gateway → browser event protocol: the event map, its names, and the runtime that
 *  decodes a frame. The JSON-only shapes those events carry live in ./payloads.js,
 *  and the per-event payload guards in ./payload-guards.js. */
import type { CompanyChangedEvent, JsonObject, JsonValue, MessageMediaWire, TalkProactiveCuePayload } from "./payloads.js";
export type * from "./payloads.js";
export interface GatewayEventMap {
    "session:started": {
        sessionId: string;
    };
    "session:created": {
        sessionId: string;
    };
    "session:updated": {
        sessionId: string;
        title?: string;
    };
    "session:deleted": {
        sessionId: string;
    };
    "session:stopped": {
        sessionId: string;
    };
    "session:external-turn": {
        sessionId: string;
    };
    /** A gateway turn started (true) or stopped (false) waiting for a turn the
     *  operator typed into the claude terminal to finish. */
    "session:terminal-wait": {
        sessionId: string;
        waiting: boolean;
    };
    "session:interrupted": {
        sessionId: string;
        reason: string;
    };
    "session:completed": {
        sessionId: string;
        result: string | null;
        error: string | null;
        employee?: string;
        title?: string | null;
        cost?: number;
        durationMs?: number;
    };
    "session:delta": {
        sessionId: string;
        type: "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block";
        content: string;
        toolName?: string;
        toolId?: string;
        activityReceiptId?: string;
        /** The background sub-agent an `Agent`/`Task` result launched, for its card to open. */
        agentId?: string;
        input?: string;
        /** A tool call made inside a sub-agent rather than by the main agent. */
        sidechain?: boolean;
        block?: JsonValue;
    };
    "session:notification": {
        sessionId: string;
        message: string;
        meta?: JsonObject;
    };
    "session:attachment": {
        sessionId: string;
        id: string;
        content: string;
        media: MessageMediaWire[];
        timestamp: number;
    };
    "session:background": {
        sessionId: string;
        transportState: string;
        /** The session's status as reported, background work included. */
        status?: string;
        backgroundActivity: {
            activeStreams: number;
            activeAgents?: number;
            activeMonitors?: number;
            backgroundAgents?: number;
            backgroundRerun?: boolean;
            lastActivityAt: string;
        } | null;
    };
    "queue:updated": {
        sessionId: string;
        sessionKey: string;
        depth?: number;
        paused?: boolean;
    };
    /** A board hook run row was written or finished; the Hooks page refetches. */
    "hooks:run": {
        id: string;
        hook: string;
        status: string;
    };
    "company:changed": CompanyChangedEvent;
    "pins:changed": Record<string, never>;
    "notes:changed": {
        path: string;
        revision: string;
        action: "created" | "updated";
    };
    /** A quick capture moved. The payload is a nudge, not the truth: the browser
     *  re-reads GET /api/todo-captures/:id, which DERIVES the stage from real
     *  state, so a reload recovers and no stage can be shown before its fact. */
    "todo-capture:stage": {
        captureId: string;
        stage: string;
        workItemId: string | null;
    };
    "org:changed": Record<string, never>;
    "config:reloaded": Record<string, never>;
    "skills:changed": Record<string, never>;
    "plugins:changed": Record<string, never>;
    /** One plugin's backend asking the dashboard to say something. The browser
     *  half of the same plugin can call `host.notify` directly; a backend has no
     *  DOM, so this frame is how the two halves reach one notification surface. */
    "plugin:notice": {
        pluginId: string;
        message: string;
        level: "info" | "warning" | "error";
    };
    "cron:reloaded": Record<string, never>;
    "cron:run-finished": {
        jobId: string;
        status: "success" | "error";
    };
    "engines:updated": Record<string, never>;
    "stt:download:progress": {
        progress: number;
    };
    "stt:download:complete": {
        model: string;
    };
    "stt:download:error": {
        error: string;
    };
    "talk:audio": {
        sessionId: string;
        seq: number;
        mime: string;
        dataBase64: string;
        last?: boolean;
    };
    "talk:tts:download:progress": {
        progress: number;
    };
    "talk:tts:download:complete": Record<string, never>;
    "talk:tts:download:error": {
        error: string;
    };
    "talk:proactive-cue": TalkProactiveCuePayload;
}
export type GatewayEventName = keyof GatewayEventMap;
export type GatewayEvent = {
    [K in GatewayEventName]: {
        event: K;
        payload: GatewayEventMap[K];
    };
}[GatewayEventName];
export type GatewayEventListener = (frame: GatewayEvent) => void;
export type GatewayEmit = <K extends GatewayEventName>(event: K, payload: GatewayEventMap[K]) => void;
export declare const GATEWAY_EVENTS: {
    readonly sessionStarted: "session:started";
    readonly sessionCreated: "session:created";
    readonly sessionUpdated: "session:updated";
    readonly sessionDeleted: "session:deleted";
    readonly sessionStopped: "session:stopped";
    readonly sessionExternalTurn: "session:external-turn";
    readonly sessionTerminalWait: "session:terminal-wait";
    readonly sessionInterrupted: "session:interrupted";
    readonly sessionCompleted: "session:completed";
    readonly sessionDelta: "session:delta";
    readonly sessionNotification: "session:notification";
    readonly sessionAttachment: "session:attachment";
    readonly sessionBackground: "session:background";
    readonly queueUpdated: "queue:updated";
    readonly hooksRun: "hooks:run";
    readonly companyChanged: "company:changed";
    readonly pinsChanged: "pins:changed";
    readonly notesChanged: "notes:changed";
    readonly todoCaptureStage: "todo-capture:stage";
    readonly orgChanged: "org:changed";
    readonly configReloaded: "config:reloaded";
    readonly skillsChanged: "skills:changed";
    readonly pluginsChanged: "plugins:changed";
    readonly pluginNotice: "plugin:notice";
    readonly cronReloaded: "cron:reloaded";
    readonly cronRunFinished: "cron:run-finished";
    readonly enginesUpdated: "engines:updated";
    readonly sttDownloadProgress: "stt:download:progress";
    readonly sttDownloadComplete: "stt:download:complete";
    readonly sttDownloadError: "stt:download:error";
    readonly talkAudio: "talk:audio";
    readonly talkTtsDownloadProgress: "talk:tts:download:progress";
    readonly talkTtsDownloadComplete: "talk:tts:download:complete";
    readonly talkTtsDownloadError: "talk:tts:download:error";
    readonly talkProactiveCue: "talk:proactive-cue";
};
export declare function isGatewayEventName(value: unknown): value is GatewayEventName;
/** Decode an untrusted websocket frame into the shared discriminated union. */
export declare function decodeGatewayEvent(value: unknown): GatewayEvent | null;
export declare function isGatewayEvent(value: unknown): value is GatewayEvent;
//# sourceMappingURL=index.d.ts.map