import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { vi } from "vitest";
import type { JinnConfig } from "../../../shared/types.js";

/**
 * Shared fixture for the /api/talk route suites. They drive handleApiRequest
 * directly with fake req/res (no HTTP server boot) against a throwaway
 * JINN_HOME, so they never touch the live session DB.
 *
 * The realtime provider is NOT mocked: the real one runs and only `fetch` is
 * stubbed. That is deliberate. It means the account key really does travel into
 * the provider, so a test asserting the key never appears in a response body is
 * testing the gateway rather than testing a stub.
 *
 * The pool is `forks`, so importing this gives each suite its own process, home,
 * and SQLite DB. JINN_HOME must be set before db.js loads; keep that order.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-route-"));
process.env.JINN_HOME = home;
export const dbModule = await import("../../../shared/db.js");

export const api = await import("../../api.js");
export const reg = await import("../../../sessions/registry.js");
dbModule.initDb();

/** A value no response body has any business containing. */
export const ACCOUNT_KEY = "test-account-key-must-never-leave-the-gateway";

export const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

export function baseConfig(): JinnConfig {
  return {
    gateway: {},
    engines: { default: "claude" },
    realtime: { provider: "openai", apiKey: ACCOUNT_KEY, model: "gpt-realtime-2.1" },
  } as unknown as JinnConfig;
}

/**
 * Stand in for OpenAI's client-secrets endpoint, carrying its expiry semantics
 * rather than a convenient version of them: a whole second, anchored at the mint,
 * exactly as `expires_after: { anchor: "created_at" }` yields. Nothing here
 * manufactures monotonicity, so two mints inside one second really do collide and
 * the gateway has to earn a later expiry.
 *
 * `fixedExpiry` pins the value instead, standing in for a provider that never
 * extends at all.
 */
export function stubMintingFetch(
  fixedExpiry?: number,
): { calls: Array<{ url: string; authorization: string; body: unknown }> } {
  const calls: Array<{ url: string; authorization: string; body: unknown }> = [];
  let issued = 0;
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
    issued += 1;
    calls.push({
      url: String(url),
      authorization: init.headers.Authorization,
      body: JSON.parse(init.body) as unknown,
    });
    return {
      ok: true,
      json: async () => ({
        value: `ephemeral-secret-${issued}`,
        expires_at: fixedExpiry ?? Math.floor(Date.now() / 1000) + 600,
      }),
    };
  });
  return { calls };
}

export function makeRes() {
  let status = 200;
  let ended = false;
  const headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number, given?: Record<string, unknown>) {
      status = code;
      Object.assign(headers, given ?? {});
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers[name] = value;
      return this;
    },
    write(buf: Buffer | string) {
      chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return true;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      ended = true;
    },
    on() {
      return this;
    },
    get writableEnded() {
      return ended;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get raw() {
      return Buffer.concat(chunks);
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return raw as unknown as Record<string, unknown>;
      }
    },
  };
}

type ApiRequest = Parameters<typeof api.handleApiRequest>[0];

export function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as ApiRequest;
}

/** Bearer credentials for the operator surface. */
export const operatorHeaders = { authorization: "Bearer test-token" };

export function makeContext(config: JinnConfig) {
  return {
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => {},
    sessionManager: {
      // Handoff looks an engine up before dispatching; none is configured here,
      // so the spawned session is created and simply never runs.
      getEngine: () => undefined,
      getQueue: () => ({
        getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as unknown as import("../../api.js").ApiContext;
}

/** Drive one request through the whole gateway dispatcher. */
export async function call(
  config: JinnConfig,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = operatorHeaders,
) {
  const res = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, body, headers), res.res, makeContext(config));
  return res;
}
