import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 * A session's fallback mode through the HTTP surface: the view GET reports, PUT's validation and
 * persistence, and what POST /api/sessions and POST /api/delegations accept, refuse and inherit.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-fallback-api-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "a-worker.yaml"),
  ["name: a-worker", "displayName: A Worker", "department: platform", "rank: employee", "engine: claude", "model: opus", "persona: Fallback mode fixture", ""].join("\n"),
);
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const dbModule = await import("../../shared/db.js");
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");

const engineStub = { name: "stub", run: () => new Promise(() => {}), isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

const baseConfig = {
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
let config: JinnConfig = baseConfig;
const emitted: Array<[string, unknown]> = [];

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

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
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

const toolHeaders = (sessionId: string) => ({
  [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
  [CALLER_SESSION_HEADER]: sessionId,
  [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
});

function makeParent(fallbackMode: SessionFallbackMode | null): Session {
  return registry.createSession({
    engine: "claude", source: "web", sourceRef: `web:parent-${Math.random()}`, model: "opus", ...(fallbackMode ? { fallbackMode } : {}),
  });
}

const spawn = (body: Record<string, unknown>, headers?: Record<string, string>) => call("POST", "/api/sessions", { prompt: "brief", ...body }, headers);
const delegate = (body: Record<string, unknown>, headers?: Record<string, string>) =>
  call("POST", "/api/delegations", { employee: "a-worker", task: "A brief with acceptance.", ...body }, headers);
const stored = (id: string) => registry.getSession(id)!.fallbackMode;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

beforeEach(() => {
  config = baseConfig;
  emitted.length = 0;
  fs.rmSync(HEALTH_PATH, { force: true });
});

describe("GET /api/sessions/:id", () => {
  it("carries the fallback view: the default mode, where it came from and the resolved target", async () => {
    const session = makeParent(null);
    const got = await call("GET", `/api/sessions/${session.id}`);
    expect(got.status).toBe(200);
    expect(got.body.fallback).toEqual({
      mode: "fallback", modeSource: "default", target: { engine: "codex", model: "gpt-mapped", label: "gpt-mapped" },
    });
  });

  it("reports a stored mode with source session, and a null target when the chain is empty", async () => {
    config = { ...baseConfig, engines: { ...baseConfig.engines, claude: { bin: "claude", model: "opus", fallback: [] } } } as JinnConfig;
    const session = makeParent("auto-resume");
    expect((await call("GET", `/api/sessions/${session.id}`)).body.fallback).toEqual({ mode: "auto-resume", modeSource: "session", target: null });
  });

  it("follows sessions.fallbackMode for a session with none of its own", async () => {
    config = { ...baseConfig, sessions: { fallbackMode: "fallback-children" } } as JinnConfig;
    const got = await call("GET", `/api/sessions/${makeParent(null).id}`);
    expect(got.body.fallback).toMatchObject({ mode: "fallback-children", modeSource: "default" });
  });

  it("is on the single-session response only, not the list", async () => {
    makeParent(null);
    const list = await call("GET", "/api/sessions");
    expect(list.status).toBe(200);
    for (const row of list.body.sessions ?? list.body) expect(row).not.toHaveProperty("fallback");
  });
});

describe("PUT /api/sessions/:id", () => {
  it("takes fallbackMode alone, persists it, emits session:updated and answers with the view", async () => {
    const session = makeParent(null);
    for (const method of ["PUT", "PATCH"]) {
      emitted.length = 0;
      const mode = method === "PUT" ? "auto-resume" : "fallback-children";
      const put = await call(method, `/api/sessions/${session.id}`, { fallbackMode: mode });
      expect(put.status).toBe(200);
      expect(put.body.fallbackMode).toBe(mode);
      expect(put.body.fallback).toMatchObject({ mode, modeSource: "session" });
      expect(stored(session.id)).toBe(mode);
      expect(emitted).toContainEqual(["session:updated", { sessionId: session.id }]);
    }
  });

  it("survives the registry being closed and opened again", async () => {
    const session = makeParent(null);
    await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: "auto-resume" });
    dbModule.__closeDbForTest();
    const got = await call("GET", `/api/sessions/${session.id}`);
    expect(got.body.fallback).toMatchObject({ mode: "auto-resume", modeSource: "session" });
  });

  it("can ride along with a title, and does not rewrite the engine", async () => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: "auto-resume", title: `retitled ${Date.now()}` });
    expect(put.status).toBe(200);
    expect(put.body.fallback.mode).toBe("auto-resume");
    expect(registry.getSession(session.id)).toMatchObject({ engine: "claude", fallbackMode: "auto-resume" });
  });

  it.each([["wait"], [null], [2], [""], ["Fallback"]])("refuses %j with a 400 naming the allowed values, changing nothing", async (bad) => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: bad });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/fallbackMode must be one of fallback, fallback-children, auto-resume/);
    expect(stored(session.id)).toBe("fallback");
  });

  it("still refuses a body with nothing to update", async () => {
    const put = await call("PUT", `/api/sessions/${makeParent(null).id}`, {});
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/no valid fields/);
  });
});

describe("POST /api/sessions", () => {
  it("stores an explicit mode, and a root with none stores NULL", async () => {
    const explicit = await spawn({ fallbackMode: "auto-resume" });
    expect(explicit.status).toBe(201);
    expect(stored(explicit.body.id)).toBe("auto-resume");
    const root = await spawn({});
    expect(root.status).toBe(201);
    expect(stored(root.body.id)).toBeNull();
  });

  it("refuses a bad value with a 400 naming the three, and creates nothing", async () => {
    const before = registry.listSessions().length;
    const bad = await spawn({ fallbackMode: "off" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/fallback, fallback-children, auto-resume/);
    expect(registry.listSessions()).toHaveLength(before);
  });

  it.each<[string, SessionFallbackMode | null, SessionFallbackMode]>([
    ["a fallback-children parent passes it on", "fallback-children", "fallback-children"],
    ["a fallback parent's child gets auto-resume", "fallback", "auto-resume"],
    ["an auto-resume parent's child gets auto-resume", "auto-resume", "auto-resume"],
    ["a legacy NULL parent follows the config default (fallback), so its child gets auto-resume", null, "auto-resume"],
  ])("%s", async (_name, parentMode, expected) => {
    const parent = makeParent(parentMode);
    const child = await spawn({ parentSessionId: parent.id });
    expect(child.status).toBe(201);
    expect(stored(child.body.id)).toBe(expected);
  });

  it("an explicit mode wins over the parent's, and a legacy NULL parent follows a fallback-children default", async () => {
    const explicit = await spawn({ parentSessionId: makeParent("auto-resume").id, fallbackMode: "fallback" });
    expect(stored(explicit.body.id)).toBe("fallback");
    config = { ...baseConfig, sessions: { fallbackMode: "fallback-children" } } as JinnConfig;
    const inherited = await spawn({ parentSessionId: makeParent(null).id });
    expect(stored(inherited.body.id)).toBe("fallback-children");
  });

  it("a tool spawn is the caller's child and takes its mode, through to a grandchild", async () => {
    const caller = makeParent("fallback-children");
    const child = await spawn({}, toolHeaders(caller.id));
    expect(registry.getSession(child.body.id)!.parentSessionId).toBe(caller.id);
    expect(stored(child.body.id)).toBe("fallback-children");
    const grandchild = await spawn({}, toolHeaders(child.body.id));
    expect(stored(grandchild.body.id)).toBe("fallback-children");
    const fromFallback = await spawn({}, toolHeaders(makeParent("fallback").id));
    expect(stored(fromFallback.body.id)).toBe("auto-resume");
  });

  it("an auto-resume child starts on its preferred engine when that engine is spent; one asking for fallback does not", async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({ claude: { state: "exhausted", until, recheckAt: until, reason: "quota window spent" } }));
    const parent = makeParent("fallback");
    const inherited = await spawn({ employee: "a-worker", parentSessionId: parent.id });
    expect(registry.getSession(inherited.body.id)).toMatchObject({ engine: "claude", fallbackMode: "auto-resume" });
    expect(registry.getSession(inherited.body.id)!.transportMeta?.engineOverride).toBeUndefined();
    const asked = await spawn({ employee: "a-worker", parentSessionId: parent.id, fallbackMode: "fallback" });
    expect(registry.getSession(asked.body.id)).toMatchObject({ engine: "codex", fallbackMode: "fallback" });
  });
});

describe("POST /api/delegations", () => {
  it("stores and echoes an explicit mode", async () => {
    const created = await delegate({ fallbackMode: "auto-resume" });
    expect(created.status).toBe(201);
    expect(created.body.fallbackMode).toBe("auto-resume");
    expect(stored(created.body.sessionId)).toBe("auto-resume");
  });

  it("a root delegation stores NULL and echoes null", async () => {
    const created = await delegate({});
    expect(created.status).toBe(201);
    expect(created.body.fallbackMode).toBeNull();
    expect(stored(created.body.sessionId)).toBeNull();
  });

  it("refuses a bad value with a 400 before minting anything", async () => {
    const bad = await delegate({ fallbackMode: "never" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/fallback, fallback-children, auto-resume/);
    expect(bad.body.workItemId).toBeUndefined();
  });

  it.each<[SessionFallbackMode | null, SessionFallbackMode]>([
    ["fallback-children", "fallback-children"], ["fallback", "auto-resume"], ["auto-resume", "auto-resume"], [null, "auto-resume"],
  ])("a delegation from a %s session stores %s", async (parentMode, expected) => {
    const created = await delegate({}, toolHeaders(makeParent(parentMode).id));
    expect(created.status).toBe(201);
    expect(created.body.fallbackMode).toBe(expected);
    expect(stored(created.body.sessionId)).toBe(expected);
  });

  it("an explicit mode beats the caller's", async () => {
    const created = await delegate({ fallbackMode: "fallback" }, toolHeaders(makeParent("auto-resume").id));
    expect(stored(created.body.sessionId)).toBe("fallback");
  });

  it("echoes the stored mode on an idempotent replay, whatever the retry says", async () => {
    const caller = toolHeaders(makeParent("fallback-children").id);
    const first = await delegate({ idempotencyKey: "fallback-mode-replay" }, caller);
    expect(first.status).toBe(201);
    const replay = await delegate({ idempotencyKey: "fallback-mode-replay", fallbackMode: "auto-resume" }, caller);
    expect(replay.body).toMatchObject({ replayed: true, sessionId: first.body.sessionId, fallbackMode: "fallback-children" });
  });
});
