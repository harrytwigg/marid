import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database, { type Database as DatabaseType } from "better-sqlite3";

/**
 * The rig the account tests drive the real request handler through: a throwaway home, an in-memory
 * database holding only the account tables (plus `departments`), and requests that enter
 * `createGatewayRequestHandler` the way the server calls it.
 *
 * JINN_HOME is set here, at module scope, because paths.js reads it once; the gateway modules are imported
 * after it through `startHarness`.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-accounts-"));
process.env.JINN_HOME = path.join(tmpRoot, "default-home");
fs.mkdirSync(process.env.JINN_HOME, { recursive: true });

export const GATEWAY_TOKEN = "gateway-token-for-account-tests-0123456789";
export const GOOD_PASSWORD = "correct horse battery staple";

export interface Reply {
  status: number;
  body: any;
  header(name: string): unknown;
  cookies: string[];
}

export interface RequestOptions {
  body?: unknown;
  cookie?: string;
  authorization?: string;
  ip?: string;
  headers?: Record<string, string>;
}

function makeReq(method: string, url: string, opts: RequestOptions): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: "gateway.test",
    "user-agent": "vitest",
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.headers ?? {}),
  };
  (req as any).socket = { remoteAddress: opts.ip ?? "203.0.113.7" };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const headers = new Map<string, unknown>();
  const res = {
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      if (h) for (const [key, value] of Object.entries(h)) headers.set(key.toLowerCase(), value);
      return this;
    },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); return this; },
  } as unknown as ServerResponse;
  return {
    res,
    reply(): Reply {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const set = headers.get("set-cookie");
      return { status, body, header: (n) => headers.get(n.toLowerCase()), cookies: set === undefined ? [] : ([] as string[]).concat(set as string | string[]) };
    },
  };
}

export interface Harness {
  db: DatabaseType;
  home: string;
  config: { gateway: Record<string, unknown> };
  rt: import("../runtime.js").AccountsRuntime;
  request(method: string, url: string, opts?: RequestOptions): Promise<Reply>;
  /** A request carrying the operator's gateway token. */
  asOperator(method: string, url: string, body?: unknown): Promise<Reply>;
  /** The `Cookie` header value for a Set-Cookie list, as a browser would send it back. */
  cookieFrom(reply: Reply): string;
  clock: { now: number };
  close(): void;
}

export async function startHarness(opts: { authRequired?: boolean; limiter?: import("../passwords.js").HashLimiter } = {}): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  fs.chmodSync(home, 0o700);
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const { ensureAccountTables } = await import("../schema.js");
  ensureAccountTables(db);
  db.exec("CREATE TABLE departments (slug TEXT PRIMARY KEY, prefix TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.prepare("INSERT INTO departments (slug, prefix, created_at) VALUES ('ops', 'OPS', '2026-01-01T00:00:00Z'), ('design', 'DES', '2026-01-01T00:00:00Z')").run();

  const { createAccountsRuntime } = await import("../runtime.js");
  const { shouldRequireGatewayAuth } = await import("../../gateway/auth.js");
  const { createGatewayRequestHandler } = await import("../../gateway/request-handler.js");
  const config = { gateway: { host: "0.0.0.0", ...(opts.authRequired === false ? { host: "127.0.0.1", authRequired: false } : {}) } as Record<string, unknown> };
  const clock = { now: Date.now() };
  const rt = createAccountsRuntime({
    getDb: () => db, home, gatewayAuthToken: GATEWAY_TOKEN,
    authRequired: () => shouldRequireGatewayAuth(config as any),
    now: () => clock.now,
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
  });
  const handler = createGatewayRequestHandler({
    authRequired: () => shouldRequireGatewayAuth(config as any),
    gatewayAuthToken: GATEWAY_TOKEN,
    home,
    webDir: path.join(tmpRoot, "no-web"),
    accounts: rt,
    apiContext: {
      gatewayAuthToken: GATEWAY_TOKEN, jinnHome: home, accounts: rt,
      getConfig: () => ({ ...config, engines: { default: "claude" } }),
      connectors: new Map(), startTime: Date.now(),
    } as any,
  });

  const request: Harness["request"] = async (method, url, o = {}) => {
    const cap = makeRes();
    await handler(makeReq(method, url, o), cap.res);
    return cap.reply();
  };
  return {
    db, home, config, rt, clock, request,
    asOperator: (method, url, body) => request(method, url, { authorization: `Bearer ${GATEWAY_TOKEN}`, ...(body === undefined ? {} : { body }) }),
    cookieFrom: (reply) => reply.cookies.map((c) => c.split(";")[0]).join("; "),
    close: () => { rt.dispose(); db.close(); },
  };
}

export { makeReq, makeRes };
