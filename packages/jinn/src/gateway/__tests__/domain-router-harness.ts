import { expect } from "vitest";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";
import { handleApiRequest } from "../api.js";
import type { ApiContext } from "../api.js";

/**
 * The request rig the domain-router contract files share. It is a module rather
 * than a block each of them repeats because `vi.mock` is per-file — the mocks have
 * to be declared in the test file, but the fake request/response pair and the
 * fixtures the routes are pinned against do not. The temp home those mocks point at
 * lives in domain-router-home.ts, which this file must not be merged into.
 */

const MODELS = [
  { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
  { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
];

const context = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol" } },
    models: { codex: { default: "gpt-5.6-sol", models: MODELS } },
    connectors: {},
    mcp: {},
  } as unknown as JinnConfig),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => undefined,
    getEngines: () => new Map(),
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get raw() { return Buffer.concat(chunks).toString("utf-8"); },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

/** Operator caller by default; pass `{}` for headers to drop operator authority. */
export async function call(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json", ...(headers ?? { authorization: "Bearer test-token" }) },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await handleApiRequest(req as unknown as Parameters<typeof handleApiRequest>[0], cap.res, context);
  return { status: cap.status, raw: cap.raw, body: cap.body };
}

/**
 * Pins a response to the bytes it wrote, not to a value parsed back out of them.
 * `toEqual` on the parsed body cannot see the wire at all: change how `json()`
 * serializes — spacing, key order — and every parsed assertion stays green while
 * every byte on the wire moves. Comparing the captured bytes against the compact
 * stringification of `expected` is what makes "byte-identical" a claim that can
 * fail.
 */
export function expectWire(response: { status: number; raw: string }, status: number, expected: unknown): void {
  expect([response.status, response.raw]).toEqual([status, JSON.stringify(expected)]);
}
