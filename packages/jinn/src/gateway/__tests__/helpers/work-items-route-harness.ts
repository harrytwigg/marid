import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { expect } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../../mcp/identity.js";

/**
 * Shared fixture for the /api/work-items route suites. They drive
 * handleApiRequest directly with fake req/res — no HTTP server boot — and point
 * the registry DB at a throwaway JINN_HOME so they never touch the live DB.
 *
 * The pool is `forks`, so importing this gives each suite its own process, its
 * own home, and its own SQLite DB. JINN_HOME must be set before db.js loads;
 * keep that order.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-route-"));
process.env.JINN_HOME = home;
export const dbModule = await import("../../../shared/db.js");

fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
);
// Unrelated to platform-worker in every direction: no shared department, no
// reporting line. Drives the "any authenticated session" status lane.
fs.writeFileSync(
  path.join(home, "org", "solo-worker.yaml"),
  "name: solo-worker\ndisplayName: Solo Worker\ndepartment: marketing\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test loner.\n",
);

export const api = await import("../../api.js");
export const reg = await import("../../../sessions/registry.js");
export const store = await import("../../../work-items/store.js");
dbModule.initDb();

type ApiRequest = Parameters<typeof api.handleApiRequest>[0];

export function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

export function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as ApiRequest;
}

export function makeRawReq(method: string, urlPath: string, raw: string, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([Buffer.from(raw)]), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as ApiRequest;
}

/** Bearer credentials for the operator surface. */
export const operatorHeaders = { authorization: "Bearer test-token" };

/** Capability headers that identify a caller as a specific agent session. */
export function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

/**
 * Values a typed validation response must never reflect back. Every one is a
 * shape an error message would be tempted to echo: an internal id, a path, a
 * SQL fragment, a credential, a control character.
 */
export const hostileInputs = [
  "wi_private_validation_marker",
  "/srv/private-validation.db",
  "SQLITE_DROP_TABLE_validation",
  "token=validation-token",
  "secret=validation-secret",
  "control\u0001marker",
];

export function expectNoHostileInput(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const input of hostileInputs) {
    const escaped = JSON.stringify(input).slice(1, -1);
    expect(serialized).not.toContain(input);
    expect(serialized).not.toContain(escaped);
  }
}

// serializeSession only reaches sessionManager.getQueue() + (absent) backgroundActivity.
export const emittedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

export const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emittedEvents.push({ event, payload }),
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../../api.js").ApiContext;
