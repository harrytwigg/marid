import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { vi, type Mock } from "vitest";
import type { Connector, EngineResult, IncomingMessage, HundredfoldConfig } from "../../../shared/types.js";

/**
 * Drives the SAME turn through both runners — the connector path
 * (`SessionManager.route`) and the web path (`POST /api/sessions`) — so their
 * receipts can be compared directly. Everything here is transport plumbing; the
 * assertions live in the suites.
 */

export const EMPLOYEE = "parity-worker";

/** Throwaway home, seeded before any registry import resolves SESSIONS_DB. */
export function createTestHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HUNDREDFOLD_HOME = home;
  fs.mkdirSync(path.join(home, "org"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "org", `${EMPLOYEE}.yaml`),
    `name: ${EMPLOYEE}\nengine: claude\npersona: Turn parity fixture\n`,
  );
  return home;
}

export interface ScriptedEngine {
  name: string;
  /** Results handed out in order; the last one repeats once exhausted. */
  script: EngineResult[];
  runs: number;
  run: (opts: { sessionId?: string }) => Promise<EngineResult>;
  isAlive: () => boolean;
  kill: () => void;
  killAll: () => void;
}

export function scriptedEngine(name: string, script: EngineResult[]): ScriptedEngine {
  const engine: ScriptedEngine = {
    name,
    script: [...script],
    runs: 0,
    async run() {
      engine.runs += 1;
      return engine.script.length > 1 ? engine.script.shift()! : engine.script[0]!;
    },
    isAlive: () => false,
    kill: () => {},
    killAll: () => {},
  };
  return engine;
}

export function engineResult(overrides: Partial<EngineResult> = {}): EngineResult {
  return { sessionId: "", result: "", ...overrides };
}

/** A rate-limited result whose reset already passed, so no retry has to wait long. */
export function rateLimitedResult(resetsAtOffsetSeconds: number): EngineResult {
  return engineResult({
    error: "429 usage limit reached",
    rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + resetsAtOffsetSeconds },
  } as Partial<EngineResult>);
}

export interface ConnectorStub extends Connector {
  replies: string[];
}

export function connectorStub(): ConnectorStub {
  const replies: string[] = [];
  const capabilities = { threading: false, messageEdits: false, reactions: false, attachments: false };
  return {
    replies,
    name: "stub",
    id: "stub",
    async start() {},
    async stop() {},
    getCapabilities: () => capabilities,
    getHealth: () => ({ status: "running", capabilities }),
    reconstructTarget: () => ({ channel: "c1" }),
    async sendMessage() { return undefined; },
    async replyMessage(_target: unknown, text: string) { replies.push(text); return undefined; },
    async addReaction() {},
    async removeReaction() {},
    async editMessage() {},
    onMessage() {},
  } as unknown as ConnectorStub;
}

export function connectorMessage(sessionKey: string, text: string): IncomingMessage {
  return {
    connector: "stub",
    source: "slack",
    sessionKey,
    replyContext: { channel: "c1" },
    channel: "c1",
    user: "u1",
    userId: "u1",
    text,
    attachments: [],
    raw: null,
  } as unknown as IncomingMessage;
}

export function testConfig(overrides: Partial<HundredfoldConfig> = {}): HundredfoldConfig {
  return {
    gateway: {},
    engines: {
      default: "claude",
      claude: { bin: process.execPath },
      codex: { bin: process.execPath },
    },
    sessions: {},
    ...overrides,
  } as unknown as HundredfoldConfig;
}

/** POST /api/sessions and return the created session id. */
export async function postSession(
  api: typeof import("../../../gateway/api.js"),
  context: unknown,
  body: Record<string, unknown>,
): Promise<string> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: "/api/sessions",
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" },
  });
  let raw = "";
  const res = {
    writeHead() { return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context as never);
  return JSON.parse(raw).id as string;
}

/** Wait until `check` holds, polling in real time. */
export async function eventually(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

/** ApiContext wired to a real SessionManager, so the web path runs for real. */
export function apiContext(manager: unknown, config: HundredfoldConfig, emit: Mock = vi.fn()): unknown {
  return {
    getConfig: () => config,
    config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    gatewayBootId: "parity-boot",
    emit,
    sessionManager: manager,
  };
}
