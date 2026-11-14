import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { GATEWAY_TOKEN, GOOD_PASSWORD } from "./accounts-harness.js";

/**
 * The rig the member board API tests drive: the real registry database (every work-item table, the account tables
 * and `sessions`), the real request handler on a real HTTP server, and requests made with `fetch`, so multipart
 * uploads and streamed attachment bytes behave as they do in production. Gateway broadcasts are recorded.
 */
export interface BoardReply {
  status: number;
  body: any;
  text: string;
  bytes: Buffer;
  header(name: string): string | null;
  cookies: string[];
}

export interface BoardRequestOptions {
  body?: unknown;
  rawBody?: Buffer | FormData;
  cookie?: string;
  bearer?: boolean;
  headers?: Record<string, string>;
}

export interface BoardHarness {
  db: import("better-sqlite3").Database;
  home: string;
  /** Where the gateway is listening, for a client (the MCP tools) that makes its own requests. */
  baseUrl: string;
  rt: import("../runtime.js").AccountsRuntime;
  /** Every `emit(event, payload)` the gateway made, in order. */
  broadcasts: Array<{ event: string; payload: any }>;
  request(method: string, url: string, opts?: BoardRequestOptions): Promise<BoardReply>;
  /** A request as the operator (the gateway token). */
  operator(method: string, url: string, body?: unknown): Promise<BoardReply>;
  /** A request as a signed-in member (their cookie). */
  as(member: Member, method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<BoardReply>;
  /** Invite and accept: a member with the role on the board. */
  join(email: string, role: "viewer" | "collaborator" | "owner", department?: string, displayName?: string): Promise<Member>;
  /**
   * Resolves when the gateway starts reading the body of the next request to `path`: the request has been routed and
   * every check made before the body is read has passed. Register it before sending the request. Rejects, naming the
   * status, when the gateway answers that request without reading its body.
   */
  bodyReadStarted(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface Member { cookie: string; userId: string; email: string; sessionId: string }

/** A session manager whose engine never runs a turn: enough for a route that starts a session (a delegation) to finish. */
const idleSessionManager = () => {
  const engine = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
  const queue = {
    enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {},
    getPendingCount: () => 0, getRowlessWaitingCount: () => 0, getTransportState: (_key: string, status: string) => status,
  };
  return { getEngines: () => new Map([["claude", engine]]), getEngine: () => engine, getQueue: () => queue };
};

/** `sessions`: give the gateway an idle session manager, for tests that drive a route which starts a session. */
export async function startBoardHarness(opts: { sessions?: boolean } = {}): Promise<BoardHarness> {
  const { initDb } = await import("../../shared/db.js");
  const db = initDb();
  // One employee on the roster, so a name can be told from an identifier a member must not see.
  const org = path.join(process.env.HUNDREDFOLD_HOME!, "org", "ops");
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(org, "alice.yaml"), "name: alice\ndisplayName: Alice\ndepartment: ops\nrank: employee\nengine: claude\nmodel: sonnet\npersona: test employee\nemoji: A\n");
  const { ensureDepartmentRegistered } = await import("../../work-items/store.js");
  for (const slug of ["ops", "design"]) ensureDepartmentRegistered(slug);
  const { createAccountsRuntime } = await import("../runtime.js");
  const { shouldRequireGatewayAuth } = await import("../../gateway/auth.js");
  const { createGatewayRequestHandler } = await import("../../gateway/request-handler.js");
  const { isKnownDepartmentSlug } = await import("../../gateway/departments-api.js");
  const { setTodoLiveEmitter } = await import("../../work-items/live-events.js");
  const home = process.env.HUNDREDFOLD_HOME!;
  const config = { gateway: { host: "0.0.0.0" } as Record<string, unknown> };
  const broadcasts: BoardHarness["broadcasts"] = [];
  const rt = createAccountsRuntime({
    getDb: () => db, home, gatewayAuthToken: GATEWAY_TOKEN,
    proxyTrust: () => config.gateway,
    authRequired: () => shouldRequireGatewayAuth(config as any),
    knownDepartment: (slug) => !!db.prepare("SELECT 1 FROM departments WHERE slug = ?").get(slug) || isKnownDepartmentSlug(slug, { getConfig: () => config } as any),
  });
  const emit = (event: string, payload: unknown) => {
    broadcasts.push({ event, payload });
    rt.memberSockets.publish(event, payload);
  };
  // In-process Todo writes (a member's status move, the operator's) reach the broadcast the way server.ts wires it.
  setTodoLiveEmitter((event) => emit("company:changed", event));
  const handler = createGatewayRequestHandler({
    authRequired: () => shouldRequireGatewayAuth(config as any),
    gatewayAuthToken: GATEWAY_TOKEN,
    home,
    webDir: path.join(home, "no-web"),
    accounts: rt,
    apiContext: {
      gatewayAuthToken: GATEWAY_TOKEN, hundredfoldHome: home, accounts: rt, emit,
      getConfig: () => ({ ...config, engines: { default: "claude" } }),
      config, connectors: new Map(), startTime: Date.now(),
      ...(opts.sessions ? { sessionManager: idleSessionManager() } : {}),
    } as any,
  });
  const bodyReaders: Array<{ path: string; resolve: () => void; reject: (err: Error) => void }> = [];
  const server = http.createServer((req, res) => {
    const index = bodyReaders.findIndex((reader) => reader.path === req.url);
    if (index >= 0) {
      const [reader] = bodyReaders.splice(index, 1);
      // A body reader attaches `data` or `readable` (directly, or through a pipe or async iteration); watching for that consumes nothing.
      let settled = false;
      const onListener = (event: string | symbol) => {
        if (event !== "data" && event !== "readable") return;
        req.off("newListener", onListener);
        settled = true;
        reader.resolve();
      };
      req.on("newListener", onListener);
      // Answered without reading the body (refused before it): say so rather than leave the test waiting for a timeout.
      res.once("finish", () => {
        if (!settled) reader.reject(new Error(`${req.method} ${req.url} was answered ${res.statusCode} before its body was read`));
      });
    }
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request: BoardHarness["request"] = async (method, url, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.bearer) headers.authorization = `Bearer ${GATEWAY_TOKEN}`;
    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody as BodyInit;
    else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["content-type"] ??= "application/json"; }
    const res = await fetch(`${base}${url}`, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual" });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf-8");
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, text, bytes, header: (n) => res.headers.get(n), cookies: res.headers.getSetCookie() };
  };
  const operator: BoardHarness["operator"] = (method, url, body) => request(method, url, { bearer: true, ...(body === undefined ? {} : { body }) });
  const as: BoardHarness["as"] = (member, method, url, body, headers) =>
    request(method, url, { cookie: member.cookie, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
  const join: BoardHarness["join"] = async (email, role, department = "ops", displayName = "Pat Member") => {
    const invite = await operator("POST", `/api/boards/${department}/invites`, { email, role });
    if (invite.status !== 200) throw new Error(`invite failed: ${invite.text}`);
    if (invite.body.granted) {
      // An existing account was added straight to the board: sign in for a cookie.
      const login = await request("POST", "/api/auth/login", { body: { email, password: GOOD_PASSWORD } });
      return memberFrom(db, email, login);
    }
    const accept = await request("POST", "/api/auth/invites/accept", { body: { token: invite.body.link.split("#")[1], displayName, password: GOOD_PASSWORD } });
    if (accept.status !== 200) throw new Error(`accept failed: ${accept.text}`);
    return memberFrom(db, email, accept);
  };
  return {
    db, home, baseUrl: base, rt, broadcasts, request, operator, as, join,
    bodyReadStarted: (path) => new Promise<void>((resolve, reject) => { bodyReaders.push({ path, resolve, reject }); }),
    async close() {
      setTodoLiveEmitter(null);
      rt.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function memberFrom(db: import("better-sqlite3").Database, email: string, reply: BoardReply): Member {
  const cookie = reply.cookies.map((c) => c.split(";")[0]).join("; ");
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase()) as { id: string };
  const session = db.prepare("SELECT id FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").get(row.id) as { id: string };
  return { cookie, userId: row.id, email, sessionId: session.id };
}
