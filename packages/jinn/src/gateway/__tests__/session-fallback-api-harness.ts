import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability,
} from "../../mcp/identity.js";
import type { JinnConfig, Session } from "../../shared/types.js";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";

/**
 * Shared setup for the session fallback-mode route tests: a temp home with one employee, a stub engine
 * and queue, the config the tests vary, and helpers for calling the real handleApiRequest. Import it
 * before anything that reads JINN_HOME, and mock `engineAvailable` in the test file.
 */

export const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-fallback-api-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "a-worker.yaml"),
  ["name: a-worker", "displayName: A Worker", "department: platform", "rank: employee", "engine: claude", "model: opus", "persona: Fallback mode fixture", ""].join("\n"),
);
export const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

export const dbModule = await import("../../shared/db.js");
let api: typeof import("../api.js");
export let registry: typeof import("../../sessions/registry.js");

export async function loadApi(): Promise<void> {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
}

export async function unloadApi(): Promise<void> {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
}

export function resetFallbackFixture(): void {
  config = baseConfig;
  emitted.length = 0;
  fs.rmSync(HEALTH_PATH, { force: true });
}

const engineStub = { name: "stub", run: () => new Promise(() => {}), isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

export const baseConfig = {
  gateway: { port: 7798, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", fallback: ["codex"], fallbackModelMap: { opus: "gpt-mapped" } },
    codex: { bin: "codex", model: "gpt-5.6-sol" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol" }, { id: "gpt-mapped" }] },
  },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as JinnConfig;
export let config: JinnConfig = baseConfig;
export function setConfig(next: JinnConfig): void { config = next; }
export const emitted: Array<[string, unknown]> = [];

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: unknown) => { emitted.push([event, payload]); },
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map([["claude", engineStub], ["codex", engineStub]]),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

export async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json", ...headers },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

export const toolHeaders = (sessionId: string) => ({
  [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
  [CALLER_SESSION_HEADER]: sessionId,
  [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
});

export function makeParent(fallbackMode: SessionFallbackMode | null): Session {
  return registry.createSession({
    engine: "claude", source: "web", sourceRef: `web:parent-${Math.random()}`, model: "opus", ...(fallbackMode ? { fallbackMode } : {}),
  });
}

export const spawn = (body: Record<string, unknown>, headers?: Record<string, string>) => call("POST", "/api/sessions", { prompt: "brief", ...body }, headers);
export const delegate = (body: Record<string, unknown>, headers?: Record<string, string>) =>
  call("POST", "/api/delegations", { employee: "a-worker", task: "A brief with acceptance.", ...body }, headers);
export const stored = (id: string) => registry.getSession(id)!.fallbackMode;

