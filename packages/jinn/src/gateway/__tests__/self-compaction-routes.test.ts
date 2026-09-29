import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability, UNIDENTIFIED_TOOL_CALL_ERROR } from "../../mcp/identity.js";

/**
 * `POST /api/compactions` against the REAL gateway API, registry and session
 * outbox (temp JINN_HOME). The route's own loopback — the compaction turn goes
 * through the ordinary message route, the resume turn through the outbox — is
 * served in-process by routing `fetch` back into handleApiRequest, so what is
 * asserted is what a live gateway would have queued, in the order it queued it.
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-self-compaction-routes-home-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");

let api: Api;
let registry: Registry;
let db: typeof import("../../shared/db.js");

function makeRes() {
  const chunks: Buffer[] = [];
  const cap = {
    status: 0,
    res: {
      writeHead(status: number) {
        cap.status = status;
        return cap.res;
      },
      setHeader() {},
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk));
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      headersSent: false,
    } as unknown as ServerResponse,
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
  return cap;
}

const killed: string[] = [];
const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {},
  hasInFlightItem: () => false,
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => true,
  isTurnRunning: () => true,
  kill: (id: string) => { killed.push(id); },
  killAll: () => {},
};
let opencodeMode: "run" | "server" = "server";
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "claude", opencode: { mode: opencodeMode } }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["claude", engineStub], ["opencode", engineStub], ["codex", engineStub]]),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function request(
  method: string,
  pathAndQuery: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const raw = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url: pathAndQuery,
    headers: {
      host: "gateway.test",
      ...(raw ? { "content-type": "application/json" } : {}),
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  let body: unknown = cap.text;
  try {
    body = JSON.parse(cap.text);
  } catch { /* non-JSON body */ }
  return { status: cap.status, body };
}

/** Every loopback the route makes, in order, and whether to fail it. */
let loopbacks: Array<{ path: string; body: Record<string, unknown> }> = [];
let failLoopback: ((index: number) => boolean) | undefined;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  db = await import("../../shared/db.js");
  // The gateway calling itself: serve it in-process, as the operator-authenticated
  // internal caller a live loopback is.
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const index = loopbacks.push({ path: url.pathname, body }) - 1;
    if (failLoopback?.(index)) return new Response(JSON.stringify({ error: "simulated" }), { status: 503 });
    const out = await request(init?.method ?? "GET", url.pathname + url.search, {
      headers: { authorization: "Bearer test-token" },
      body,
    });
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  loopbacks = [];
  failLoopback = undefined;
  opencodeMode = "server";
});

function asSession(sessionId: string): Record<string, string> {
  return {
    "x-jinn-tool-call": "jinn-mcp",
    "x-jinn-caller-session": sessionId,
    "x-jinn-session-capability": ensureSessionCapability(sessionId)!,
  };
}

let counter = 0;
function newSession(engine: string, extra: { parentSessionId?: string } = {}): string {
  counter += 1;
  const session = registry.createSession({
    engine,
    source: "web",
    sourceRef: `compaction-${counter}`,
    ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
  });
  // The caller is mid-turn: that turn is the one asking.
  registry.updateSession(session.id, { status: "running", attemptToken: `attempt-${counter}` } as never);
  return session.id;
}

function queuedPrompts(sessionId: string): string[] {
  return (db.initDb()
    .prepare("SELECT prompt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY position ASC, created_at ASC")
    .all(sessionId) as Array<{ prompt: string }>).map((row) => row.prompt);
}

const HANDOFF = {
  goal: "Ship TASK-1 self-compaction",
  done: "route + tool written",
  next: "run the suites, then open the PR",
  context: "branch feat/self-compaction",
  waitingOn: "session qa-1: review findings",
};

describe("POST /api/compactions — integration against the real routes and outbox", () => {
  it("queues the compaction turn and then the resume turn on the caller's own session, in that order", async () => {
    const me = newSession("claude");
    const res = await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "scheduled", sessionId: me, engine: "claude", resume: "accepted" });

    // Both went through the ordinary message route to the caller itself.
    expect(loopbacks.map((call) => call.path)).toEqual([`/api/sessions/${me}/message`, `/api/sessions/${me}/message`]);
    const prompts = queuedPrompts(me);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/^\/compact Self-compaction requested by this session/);
    expect(prompts[0]).toMatch(/Current goal: Ship TASK-1 self-compaction$/);
    expect(prompts[1]).toMatch(/^\[Self-compaction resume\]/);
    expect(prompts[1]).toContain("## Next\nrun the suites, then open the PR");
    expect(prompts[1]).toContain("## Waiting on\nsession qa-1: review findings");

    // Neither is an interrupt: the asking turn keeps running to its end.
    expect(killed).not.toContain(me);
    // The resume turn is a durable outbox delivery, accepted.
    const delivery = db.initDb()
      .prepare("SELECT status, delivery_kind AS kind FROM callback_deliveries WHERE target_session_id = ?")
      .all(me) as Array<{ status: string; kind: string }>;
    expect(delivery).toEqual([{ status: "accepted", kind: "self-compaction-resume" }]);
  });

  it("allows one compaction per cooldown window, so a second call in the same turn is refused", async () => {
    const me = newSession("claude");
    expect((await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF })).status).toBe(202);
    const again = await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF });
    expect(again.status).toBe(429);
    expect((again.body as { error: string }).error).toMatch(/already requested a compaction.*end your turn/i);
    expect(queuedPrompts(me)).toHaveLength(2);
  });

  it("suppresses the parent callback for the turn that asked, when the caller is a child", async () => {
    const parent = newSession("claude");
    const child = newSession("claude", { parentSessionId: parent });
    expect((await request("POST", "/api/compactions", { headers: asSession(child), body: HANDOFF })).status).toBe(202);
    const session = registry.getSession(child)!;
    expect(session.transportMeta?.reportedToParentAttempt).toBe(session.attemptToken);
  });

  it("does not mark a session with no parent", async () => {
    const me = newSession("claude");
    await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF });
    expect(registry.getSession(me)!.transportMeta?.reportedToParentAttempt).toBeUndefined();
  });

  it("schedules nothing, and gives the claim back, when the compaction turn cannot be queued", async () => {
    const me = newSession("claude");
    failLoopback = (index) => index === 0;
    const res = await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF });
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toMatch(/nothing was scheduled/);
    expect(queuedPrompts(me)).toEqual([]);
    // Released: an immediate retry is not caught by the cooldown.
    failLoopback = undefined;
    expect((await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF })).status).toBe(202);
  });

  it("keeps the resume turn durable when its first delivery attempt fails", async () => {
    const me = newSession("claude");
    failLoopback = (index) => index === 1;
    const res = await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ resume: "retrying" });
    // Compaction queued; the resume is pending in the outbox, which can only
    // land it after the compaction turn, never ahead of it.
    expect(queuedPrompts(me)).toHaveLength(1);
    const pending = db.initDb()
      .prepare("SELECT status FROM callback_deliveries WHERE target_session_id = ?")
      .all(me) as Array<{ status: string }>;
    expect(pending).toEqual([{ status: "pending" }]);
  });

  it("refuses while messages are already queued, so no turn can run between the handoff and the compaction", async () => {
    const me = newSession("claude");
    // A child's reply that reached the session while the asking turn ran.
    const queued = await request("POST", `/api/sessions/${me}/message`, {
      headers: { authorization: "Bearer test-token" },
      body: { message: "child says: review found 3 bugs", role: "notification" },
    });
    expect(queued.status).toBe(200);
    const refused = await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toMatch(/1 message is already queued.*handle what is queued/);
    // Nothing added behind it, and the claim was given back.
    expect(queuedPrompts(me)).toEqual(["child says: review found 3 bugs"]);
    db.initDb().prepare("UPDATE queue_items SET status = 'completed' WHERE session_id = ?").run(me);
    expect((await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF })).status).toBe(202);
  });

  it("drives opencode only in server mode, and refuses engines with no native compaction", async () => {
    const oc = newSession("opencode");
    opencodeMode = "run";
    const refused = await request("POST", "/api/compactions", { headers: asSession(oc), body: HANDOFF });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toMatch(/server mode/);
    opencodeMode = "server";
    expect((await request("POST", "/api/compactions", { headers: asSession(oc), body: HANDOFF })).status).toBe(202);

    const codex = newSession("codex");
    const unsupported = await request("POST", "/api/compactions", { headers: asSession(codex), body: HANDOFF });
    expect(unsupported.status).toBe(409);
    expect(loopbacks.filter((call) => call.path.includes(codex))).toEqual([]);
  });

  it("rejects an incomplete handoff before claiming anything", async () => {
    const me = newSession("claude");
    const res = await request("POST", "/api/compactions", { headers: asSession(me), body: { goal: "g", done: "d" } });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/next is required/);
    expect((await request("POST", "/api/compactions", { headers: asSession(me), body: HANDOFF })).status).toBe(202);
  });

  it("refuses a caller with no bound session identity, and the operator", async () => {
    const anonymous = await request("POST", "/api/compactions", { headers: { "x-jinn-tool-call": "jinn-mcp" }, body: HANDOFF });
    expect(anonymous.status).toBe(403);
    expect((anonymous.body as { error: string }).error).toBe(UNIDENTIFIED_TOOL_CALL_ERROR);
    const operator = await request("POST", "/api/compactions", { headers: { authorization: "Bearer test-token" }, body: HANDOFF });
    expect(operator.status).toBe(403);
    expect(loopbacks).toEqual([]);
  });
});
