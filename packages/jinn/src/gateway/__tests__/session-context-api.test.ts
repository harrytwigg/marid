import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { Engine, EngineRunOpts, JinnConfig, Session, StreamDelta } from "../../shared/types.js";
import type { AvailabilityDeps } from "../session-context-api.js";

/**
 * The context meter's routes against the REAL gateway API, registry and queue
 * rows (temp JINN_HOME). As in the self-compaction route tests, the route's own
 * loopback through the message route is served in-process by routing `fetch`
 * back into handleApiRequest, so what is asserted is what a live gateway would
 * have queued.
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-context-meter-api-home-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Availability = typeof import("../session-context-api.js");

let api: Api;
let registry: Registry;
let queueItems: typeof import("../../sessions/queue-item-registry.js");
let models: typeof import("../../shared/models.js");
let autoCompaction: typeof import("../../sessions/auto-compaction.js");
let availability: Availability;
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
  kill: () => {},
  killAll: () => {},
};
let opencodeMode: "run" | "server" = "server";
let engineConfig: Record<string, unknown> = {};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "claude", opencode: { mode: opencodeMode }, ...engineConfig }, sessions: {} }),
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
): Promise<{ status: number; body: any }> {
  const raw = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url: pathAndQuery,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      ...(raw ? { "content-type": "application/json" } : {}),
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  let body: any = cap.text;
  try {
    body = JSON.parse(cap.text);
  } catch { /* non-JSON body */ }
  return { status: cap.status, body };
}

let loopbacks: Array<{ path: string; body: Record<string, unknown> }> = [];
let failLoopback = false;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  queueItems = await import("../../sessions/queue-item-registry.js");
  models = await import("../../shared/models.js");
  autoCompaction = await import("../../sessions/auto-compaction.js");
  availability = await import("../session-context-api.js");
  db = await import("../../shared/db.js");
  models.setDiscoveredClaudeModelsForTest({
    defaultModel: "opus",
    models: [
      { id: "opus", label: "Opus (Latest)", supportsEffort: true, effortLevels: [], contextWindow: 200_000 },
      { id: "sonnet", label: "Sonnet (Latest)", supportsEffort: true, effortLevels: [] },
    ],
  });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    loopbacks.push({ path: url.pathname, body });
    if (failLoopback) return new Response(JSON.stringify({ error: "simulated" }), { status: 503 });
    const out = await request(init?.method ?? "GET", url.pathname + url.search, { body });
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  models.setDiscoveredClaudeModelsForTest(null);
});

beforeEach(() => {
  loopbacks = [];
  failLoopback = false;
  opencodeMode = "server";
  engineConfig = {};
});

function asSession(sessionId: string): Record<string, string> {
  return {
    "x-jinn-tool-call": "jinn-mcp",
    "x-jinn-caller-session": sessionId,
    "x-jinn-session-capability": ensureSessionCapability(sessionId)!,
  };
}

let counter = 0;
/** An idle chat on `engine`, with a conversation to compact unless `conversation` is false. */
function newSession(engine: string, opts: { conversation?: boolean; parentSessionId?: string; source?: string } = {}): Session {
  counter += 1;
  const session = registry.createSession({
    engine,
    source: opts.source ?? "web",
    sourceRef: `context-meter-${counter}`,
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
  });
  if (opts.conversation !== false && engine !== "terminal") registry.recordEngineSessionId(session.id, engine, `${engine}-thread-${counter}`, {});
  return registry.getSession(session.id)!;
}

/** Every pending turn row, internal (notification-role) ones included. */
const pendingPrompts = (id: string): string[] => (db.initDb()
  .prepare("SELECT prompt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY position ASC, created_at ASC")
  .all(id) as Array<{ prompt: string }>).map((row) => row.prompt);
/** The turn has run: nothing is pending or running any more. */
const finishQueue = (id: string): void => {
  db.initDb().prepare("UPDATE queue_items SET status = 'completed' WHERE session_id = ?").run(id);
};
const selfCompactionAt = (id: string) => registry.getSession(id)!.transportMeta?.selfCompactionAt;

describe("compactAvailability", () => {
  const NOW = 1_800_000_000_000;
  const deps = (over: Partial<AvailabilityDeps> = {}): AvailabilityDeps => ({
    opencodeMode: "server",
    now: NOW,
    isAutoCompacting: () => false,
    reportedStatus: (s) => s.status,
    runningTurnIsCompaction: () => false,
    pendingQueueCount: () => 0,
    ...over,
  });
  const session = (over: Record<string, unknown> = {}): Session => ({
    id: "s1", engine: "claude", source: "web", status: "idle", engineSessionId: "thread-1", engineSessions: null, transportMeta: null, ...over,
  }) as unknown as Session;
  const code = (s: Session, d: AvailabilityDeps) => {
    const result = availability.compactAvailability(s, d);
    return result.available ? "available" : result.reason.code;
  };

  it("is available for an idle session with a conversation and nothing queued", () => {
    expect(availability.compactAvailability(session(), deps())).toEqual({ available: true });
  });

  it("refuses each way, with a short message", () => {
    const messages = {
      terminal: availability.compactAvailability(session({ source: "terminal", engine: "terminal" }), deps()),
      unsupported: availability.compactAvailability(session({ engine: "codex" }), deps()),
      noConversation: availability.compactAvailability(session({ engineSessionId: null }), deps()),
      compacting: availability.compactAvailability(session(), deps({ isAutoCompacting: () => true })),
      busy: availability.compactAvailability(session({ status: "running" }), deps()),
      queued: availability.compactAvailability(session(), deps({ pendingQueueCount: () => 2 })),
    };
    expect(Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, v.available ? "available" : v.reason.code]))).toEqual({
      terminal: "terminal", unsupported: "unsupported", noConversation: "no-conversation", compacting: "compacting", busy: "busy", queued: "queued",
    });
    for (const refused of Object.values(messages)) {
      if (refused.available) throw new Error("expected a refusal");
      expect(refused.reason.message.length).toBeGreaterThan(10);
      expect(refused.reason.message.length).toBeLessThan(260);
      expect(refused.retryAt).toBeUndefined();
    }
    expect(messages.queued.available === false && messages.queued.reason.message).toMatch(/^2 messages are queued/);
  });

  it("names run mode for opencode and no native compaction for other engines", () => {
    const run = availability.compactAvailability(session({ engine: "opencode" }), deps({ opencodeMode: "run" }));
    expect(run.available === false && run.reason).toMatchObject({ code: "unsupported", message: expect.stringMatching(/server mode/) });
    const other = availability.compactAvailability(session({ engine: "grok" }), deps());
    expect(other.available === false && other.reason).toMatchObject({ code: "unsupported", message: expect.stringMatching(/isn't supported on the grok engine/) });
    expect(code(session({ engine: "opencode", engineSessionId: "x" }), deps({ opencodeMode: "server" }))).toBe("available");
  });

  it("treats a waiting session, and one with live background work, as busy", () => {
    expect(code(session({ status: "waiting" }), deps())).toBe("busy");
    expect(code(session({ status: "idle" }), deps({ reportedStatus: () => "running" }))).toBe("busy");
  });

  it("reads a running compaction turn as compacting, not busy", () => {
    const running = session({ status: "running" });
    expect(code(running, deps({ runningTurnIsCompaction: () => true }))).toBe("compacting");
    // The running turn only counts while a turn is running.
    expect(code(session(), deps({ runningTurnIsCompaction: () => true }))).toBe("available");
  });

  it("refuses by the documented order: terminal, unsupported, no-conversation, compacting, busy, queued, cooldown", () => {
    const everything = deps({ isAutoCompacting: () => true, pendingQueueCount: () => 3 });
    const cooling = { selfCompactionAt: NOW - 1000 };
    const full = (over: Record<string, unknown>) => session({ status: "running", transportMeta: cooling, ...over });

    expect(code(full({ source: "terminal", engine: "terminal", engineSessionId: null }), everything)).toBe("terminal");
    expect(code(full({ engine: "codex", engineSessionId: null }), everything)).toBe("unsupported");
    expect(code(full({ engineSessionId: null }), everything)).toBe("no-conversation");
    expect(code(full({}), everything)).toBe("compacting");
    expect(code(full({}), deps({ pendingQueueCount: () => 3 }))).toBe("busy");
    expect(code(session({ transportMeta: cooling }), deps({ pendingQueueCount: () => 3 }))).toBe("queued");
    expect(code(session({ transportMeta: cooling }), deps())).toBe("cooldown");
  });

  it("reads the cooldown without claiming it, and says when it ends", () => {
    const claimedAt = NOW - 60_000;
    const refused = availability.compactAvailability(session({ transportMeta: { selfCompactionAt: claimedAt } }), deps());
    expect(refused).toMatchObject({ available: false, reason: { code: "cooldown" }, retryAt: new Date(claimedAt + 10 * 60_000).toISOString() });
    // At the end of the window it is available again.
    expect(availability.compactAvailability(session({ transportMeta: { selfCompactionAt: NOW - 10 * 60_000 } }), deps())).toEqual({ available: true });
    expect(availability.compactAvailability(session({ transportMeta: { selfCompactionAt: "garbage" } }), deps())).toEqual({ available: true });
  });
});

describe("GET /api/sessions/:id/context-usage", () => {
  it("reports the size, the model's window, the policy and that a compaction is available", async () => {
    const s = newSession("claude");
    registry.updateSession(s.id, { model: "opus", lastContextTokens: 123_456 });
    engineConfig = { claude: { autoCompact: { enabled: true, maxContextTokens: 150_000 } } };
    const res = await request("GET", `/api/sessions/${s.id}/context-usage`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: s.id,
      engine: "claude",
      model: "opus",
      modelLabel: "Opus (Latest)",
      contextTokens: 123_456,
      contextWindow: 200_000,
      autoCompact: { enabled: true, budgetTokens: 150_000 },
      compact: { available: true },
    });
  });

  it("uses the engine's default model, and nulls for what is unknown", async () => {
    const fresh = newSession("claude", { conversation: false });
    const res = await request("GET", `/api/sessions/${fresh.id}/context-usage`);
    expect(res.body).toMatchObject({
      model: "opus", modelLabel: "Opus (Latest)", contextTokens: null, contextWindow: 200_000,
      autoCompact: { enabled: false, budgetTokens: null },
      compact: { available: false, reason: { code: "no-conversation" } },
    });

    const noWindow = newSession("claude");
    registry.updateSession(noWindow.id, { model: "sonnet" });
    expect((await request("GET", `/api/sessions/${noWindow.id}/context-usage`)).body).toMatchObject({ model: "sonnet", contextWindow: null });
  });

  it("reads a [1m] model as 1,000,000", async () => {
    const s = newSession("claude");
    registry.updateSession(s.id, { model: "opus[1m]" });
    expect((await request("GET", `/api/sessions/${s.id}/context-usage`)).body).toMatchObject({ model: "opus[1m]", contextWindow: 1_000_000 });
  });

  it("says unsupported (with a null policy) for an engine that cannot compact", async () => {
    const s = newSession("codex");
    const body = (await request("GET", `/api/sessions/${s.id}/context-usage`)).body;
    expect(body).toMatchObject({ engine: "codex", autoCompact: { enabled: false, budgetTokens: null }, compact: { available: false, reason: { code: "unsupported" } } });
    expect(body.compact.retryAt).toBeUndefined();
  });

  it("reports a refusal for a terminal session", async () => {
    const s = newSession("terminal", { source: "terminal" });
    expect((await request("GET", `/api/sessions/${s.id}/context-usage`)).body.compact.reason.code).toBe("terminal");
  });

  it("reports busy while a turn runs, queued behind it, and compacting for a compaction turn or an auto-compaction", async () => {
    const s = newSession("claude");
    registry.updateSession(s.id, { status: "running" } as never);
    const compactOf = async () => (await request("GET", `/api/sessions/${s.id}/context-usage`)).body.compact.reason.code;
    expect(await compactOf()).toBe("busy");

    const itemId = queueItems.enqueueQueueItem(s.id, s.sessionKey, "/compact");
    queueItems.markQueueItemRunning(itemId);
    expect(await compactOf()).toBe("compacting");
    queueItems.markQueueItemCompleted(itemId);
    expect(await compactOf()).toBe("busy");

    registry.updateSession(s.id, { status: "idle" } as never);
    queueItems.enqueueQueueItem(s.id, s.sessionKey, "hello");
    expect(await compactOf()).toBe("queued");

    const other = newSession("claude");
    autoCompaction.markAutoCompacting(other.id, true);
    try {
      expect((await request("GET", `/api/sessions/${other.id}/context-usage`)).body.compact.reason.code).toBe("compacting");
    } finally {
      autoCompaction.markAutoCompacting(other.id, false);
    }
  });

  it("reports the cooldown with retryAt, and never claims it", async () => {
    const s = newSession("claude");
    expect(selfCompactionAt(s.id)).toBeUndefined();
    await request("GET", `/api/sessions/${s.id}/context-usage`);
    await request("GET", `/api/sessions/${s.id}/context-usage`);
    expect(selfCompactionAt(s.id)).toBeUndefined();

    const claimedAt = Date.now() - 120_000;
    registry.claimSelfCompaction(s.id, claimedAt, 600_000);
    const body = (await request("GET", `/api/sessions/${s.id}/context-usage`)).body;
    expect(body.compact).toMatchObject({ available: false, reason: { code: "cooldown" }, retryAt: new Date(claimedAt + 600_000).toISOString() });
    expect(selfCompactionAt(s.id)).toBe(claimedAt);
  });

  it("answers 404 for an unknown session", async () => {
    const res = await request("GET", "/api/sessions/no-such-session/context-usage");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/compact", () => {
  it("queues the bare /compact turn through the message route, with the meter's display text, and claims the cooldown", async () => {
    const s = newSession("claude");
    const res = await request("POST", `/api/sessions/${s.id}/compact`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "queued", sessionId: s.id, engine: "claude" });

    expect(loopbacks).toEqual([{
      path: `/api/sessions/${s.id}/message`,
      body: { message: "/compact", role: "notification", displayMessage: "🗜️ Compacting context — requested from the context meter" },
    }]);
    expect(pendingPrompts(s.id)).toEqual(["/compact"]);
    expect(registry.getMessages(s.id).map((m) => `${m.role}: ${m.content}`)).toEqual(["notification: 🗜️ Compacting context — requested from the context meter"]);
    expect(typeof selfCompactionAt(s.id)).toBe("number");
  });

  it("queues a turn that really is a compaction: the engine gets /compact, the chat says so, and the size is settled", async () => {
    const { runTurn } = await import("../../sessions/turn/runner.js");
    const { createWebTurnSurface } = await import("../web-turn-surface.js");
    const s = newSession("claude");
    registry.updateSession(s.id, { lastContextTokens: 531_000 });
    expect((await request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);

    const deltas: StreamDelta[] = [];
    const prompts: string[] = [];
    const engine: Engine = {
      name: "claude",
      async run(opts: EngineRunOpts) {
        prompts.push(opts.prompt);
        return { sessionId: `claude-thread-${s.id}`, result: "", compaction: { preTokens: 531_000, postTokens: 8_800 }, contextTokens: 8_800 };
      },
    };
    const surface = createWebTurnSurface({
      sessionId: s.id,
      emit: ((event: string, payload: { type?: string; content?: string }) => {
        if (event === "session:delta" && payload.type === "status") deltas.push({ type: "status", content: payload.content ?? "" });
      }) as never,
      connectors: new Map(),
      getConfig: () => ({}) as JinnConfig,
    });
    const started = registry.beginSessionAttempt(s.id)!;
    await runTurn({
      session: registry.getSession(s.id)!,
      attemptToken: started.attemptToken!,
      prompt: pendingPrompts(s.id)[0]!,
      attachments: [],
      config: apiCtx.getConfig() as unknown as JinnConfig,
      engines: new Map([["claude", engine]]),
      gatewayBootId: "test-boot",
      connectorNames: [],
      channel: "web",
      user: "operator",
    }, surface);

    expect(prompts).toEqual(["/compact"]);
    expect(deltas.map((d) => d.content)).toContain("🗜️ Compacting context…");
    expect(registry.getMessages(s.id).map((m) => m.content)).toContain("🗜️ Context compacted: 531k tokens → 8.8k tokens.");
    expect(registry.getSession(s.id)!.lastContextTokens).toBe(8_800);
  });

  it("refuses a second request while the first is still queued, then inside the cooldown with 429 and when it ends", async () => {
    const s = newSession("claude");
    expect((await request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);
    // Queued comes before the cooldown in the order of checks.
    expect((await request("POST", `/api/sessions/${s.id}/compact`)).body).toMatchObject({ code: "queued" });
    finishQueue(s.id);
    const again = await request("POST", `/api/sessions/${s.id}/compact`);
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "cooldown", error: expect.any(String) });
    expect(Date.parse(again.body.retryAt)).toBe(selfCompactionAt(s.id) as number + 600_000);
    expect(loopbacks).toHaveLength(1);
  });

  it("shares the cooldown with a self-requested compaction", async () => {
    const s = newSession("claude");
    registry.claimSelfCompaction(s.id, Date.now(), 600_000);
    const res = await request("POST", `/api/sessions/${s.id}/compact`);
    expect(res.status).toBe(429);
    expect(loopbacks).toEqual([]);
  });

  it("answers each refusal with 409 and its code, and claims nothing", async () => {
    const cases: Array<[string, () => Session]> = [
      ["terminal", () => newSession("terminal", { source: "terminal" })],
      ["unsupported", () => newSession("codex")],
      ["no-conversation", () => newSession("claude", { conversation: false })],
      ["busy", () => {
        const s = newSession("claude");
        registry.updateSession(s.id, { status: "running" } as never);
        return s;
      }],
      ["queued", () => {
        const s = newSession("claude");
        queueItems.enqueueQueueItem(s.id, s.sessionKey, "hello");
        return s;
      }],
    ];
    for (const [expected, make] of cases) {
      const s = make();
      const res = await request("POST", `/api/sessions/${s.id}/compact`);
      expect(res.status, expected).toBe(409);
      expect(res.body, expected).toMatchObject({ code: expected, error: expect.any(String) });
      expect(selfCompactionAt(s.id), expected).toBeUndefined();
    }
    const running = newSession("claude");
    registry.updateSession(running.id, { status: "running" } as never);
    const itemId = queueItems.enqueueQueueItem(running.id, running.sessionKey, "/compact keep the plan");
    queueItems.markQueueItemRunning(itemId);
    expect((await request("POST", `/api/sessions/${running.id}/compact`)).body).toMatchObject({ code: "compacting" });
    expect(loopbacks).toEqual([]);
  });

  it("refuses opencode in run mode and accepts it in server mode", async () => {
    const s = newSession("opencode");
    opencodeMode = "run";
    expect((await request("POST", `/api/sessions/${s.id}/compact`)).body).toMatchObject({ code: "unsupported", error: expect.stringMatching(/server mode/) });
    opencodeMode = "server";
    expect((await request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);
    expect(pendingPrompts(s.id)).toEqual(["/compact"]);
  });

  it("answers 502 and gives the claim back when the turn cannot be queued, so the meter can retry at once", async () => {
    const s = newSession("claude");
    failLoopback = true;
    const res = await request("POST", `/api/sessions/${s.id}/compact`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Nothing was queued: .*simulated/);
    expect(selfCompactionAt(s.id)).toBeUndefined();
    expect((await request("GET", `/api/sessions/${s.id}/context-usage`)).body.compact).toEqual({ available: true });

    failLoopback = false;
    expect((await request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);
  });

  it("answers 404 for an unknown session", async () => {
    expect((await request("POST", "/api/sessions/no-such-session/compact")).status).toBe(404);
  });

  it("is open to the operator, to a session that spawned the target and to its delegator, not to others", async () => {
    const parent = newSession("claude");
    const child = newSession("claude", { parentSessionId: parent.id });
    const stranger = newSession("claude");

    const unidentified = await request("POST", `/api/sessions/${child.id}/compact`, { headers: { "x-jinn-tool-call": "jinn-mcp" } });
    expect(unidentified.status).toBe(403);

    const lateral = await request("POST", `/api/sessions/${child.id}/compact`, { headers: asSession(stranger.id) });
    expect(lateral.status).toBe(403);
    expect(lateral.body.error).toMatch(/not a descendant of your session/);
    expect(selfCompactionAt(child.id)).toBeUndefined();

    const own = await request("POST", `/api/sessions/${child.id}/compact`, { headers: asSession(parent.id) });
    expect(own.status).toBe(202);

    const operator = newSession("claude");
    expect((await request("POST", `/api/sessions/${operator.id}/compact`)).status).toBe(202);
  });
});

afterAll(() => {
  try {
    db.initDb().close();
  } catch { /* already closed */ }
});
