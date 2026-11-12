import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/**
 * `POST /api/compactions` with a target (contracts §2) against the real gateway API, registry and
 * outbox, in a temp home: every row's status and body keys, and that a refusal leaves the target,
 * the slots, the queue, the claim and the pending switch exactly as they were.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-compactions-switch-"));
process.env.JINN_HOME = home;
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");
const OUTSIDE = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const ALPHA = path.join(OUTSIDE, "compactions-switch-alpha");
const BETA = path.join(OUTSIDE, "compactions-switch-beta");
const uninstalled = new Set<string>();

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: (_config: unknown, name: string) => !uninstalled.has(name),
}));

const { ensureSessionCapability } = await import("../../mcp/identity.js");
const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("./department-fixtures.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

type Api = typeof import("../api.js");
let api: Api;
let registry: typeof import("../../sessions/registry.js");
let db: typeof import("../../shared/db.js");
let pending: typeof import("../../sessions/pending-switch.js");
let stopped: typeof import("../../sessions/stopped-marker.js");
const alpha = claudeProfileFromDir(ALPHA);

const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { alpha: { configDir: ALPHA }, beta: { configDir: BETA } } },
    codex: { bin: "codex", model: "gpt-5.5" },
    opencode: { bin: "opencode", mode: "server" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/jinn" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  sessions: {},
} as unknown as JinnConfig;

let mode: "run" | "server" = "server";
const killed: string[] = [];
const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => true, isTurnRunning: () => true, kill: (id: string) => { killed.push(id); }, killAll: () => {} };
const queueStub = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {},
  holdForCallbackDrain: () => {}, releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const apiCtx = {
  getConfig: () => ({ ...config, engines: { ...config.engines, opencode: { bin: "opencode", mode } } }),
  connectors: new Map(), startTime: Date.now(), gatewayAuthToken: "test-token", emit: () => {},
  sessionManager: { getEngines: () => new Map([["claude", engineStub]]), getEngine: () => engineStub, getQueue: () => queueStub },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  const chunks: Buffer[] = [];
  const cap = {
    status: 0,
    res: {
      writeHead(status: number) { cap.status = status; return cap.res; }, setHeader() {},
      end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
      write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; }, headersSent: false,
    } as unknown as ServerResponse,
    get text() { return Buffer.concat(chunks).toString("utf-8"); },
  };
  return cap;
}

async function request(method: string, pathAndQuery: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const raw = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method, url: pathAndQuery,
    headers: { host: "gateway.test", ...(raw ? { "content-type": "application/json" } : {}), ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as IncomingMessage, cap.res, apiCtx);
  let body: unknown = cap.text;
  try { body = JSON.parse(cap.text); } catch { /* not JSON */ }
  return { status: cap.status, body: body as Record<string, unknown> };
}

let loopbacks: Array<{ path: string; body: Record<string, unknown> }> = [];
let failLoopback: ((index: number) => boolean) | undefined;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  db = await import("../../shared/db.js");
  pending = await import("../../sessions/pending-switch.js");
  stopped = await import("../../sessions/stopped-marker.js");
  const { refreshOrg } = await import("../org-registry.js");
  db.initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  writeEmployeeFile("platform", "far-dev", { department: "platform", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg(config);
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const index = loopbacks.push({ path: url.pathname, body }) - 1;
    if (failLoopback?.(index)) return new Response(JSON.stringify({ error: "simulated" }), { status: 503 });
    const out = await request(init?.method ?? "GET", url.pathname + url.search, { headers: { authorization: "Bearer test-token" }, body });
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
}, 60_000);

afterAll(() => { vi.unstubAllGlobals(); fs.rmSync(HEALTH_PATH, { force: true }); });

beforeEach(() => {
  loopbacks = [];
  failLoopback = undefined;
  mode = "server";
  uninstalled.clear();
  fs.rmSync(HEALTH_PATH, { force: true });
  db.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM callback_deliveries; DELETE FROM sessions;");
});

const asSession = (id: string) => ({ "x-jinn-tool-call": "jinn-mcp", "x-jinn-caller-session": id, "x-jinn-session-capability": ensureSessionCapability(id)! });

let counter = 0;
function newSession(over: Partial<Parameters<typeof registry.createSession>[0]> = {}): string {
  counter += 1;
  const s = registry.createSession({ engine: "claude", source: "web", sourceRef: `switch-${counter}`, model: "opus", employee: "plain-dev", ...over });
  registry.updateSession(s.id, { status: "running", attemptToken: `attempt-${counter}` } as never);
  return s.id;
}

const queuedPrompts = (id: string): string[] => (db.initDb()
  .prepare("SELECT prompt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY position ASC, created_at ASC")
  .all(id) as Array<{ prompt: string }>).map((row) => row.prompt);
const deliveries = (id: string) => db.initDb().prepare("SELECT status FROM callback_deliveries WHERE target_session_id = ?").all(id) as Array<{ status: string }>;

const HANDOFF = { goal: "Ship it", done: "built", next: "open the PR", context: "branch x", waitingOn: "child-1" };
const post = (id: string, body: Record<string, unknown>) => request("POST", "/api/compactions", { headers: asSession(id), body: { ...HANDOFF, ...body } });

/** Everything a refusal must leave alone (SC-004). */
function snapshot(id: string) {
  const s = registry.getSession(id)!;
  return {
    engine: s.engine, dir: s.claudeConfigDir, model: s.model, slots: JSON.stringify(s.engineSessions), status: s.status,
    claim: s.transportMeta?.selfCompactionAt ?? null, pending: s.transportMeta?.pendingSwitch ?? null,
    queue: queuedPrompts(id), deliveries: deliveries(id), loopbacks: loopbacks.length,
  };
}

function exhaust(key: string) {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_PATH, JSON.stringify({ [key]: { state: "exhausted", until, recheckAt: until, reason: "spent" } }));
  return until;
}

describe("scheduled (202)", () => {
  it("answers with the switch and leaves a pending switch, a /compact turn and the resume, in that order", async () => {
    const me = newSession();
    const res = await post(me, { profile: "alpha" });
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(["engine", "resume", "sessionId", "status", "switch"]);
    expect(res.body).toMatchObject({ status: "scheduled", sessionId: me, engine: "claude", resume: "accepted" });
    expect(Object.keys(res.body.switch as object).sort()).toEqual(["compaction", "conversation", "from", "to"]);
    expect(res.body.switch).toMatchObject({
      conversation: "new", compaction: "queued",
      from: { engine: "claude", profile: null }, to: { engine: "claude", profile: "alpha", model: "opus" },
    });
    const prompts = queuedPrompts(me);
    expect(prompts[0]).toMatch(/^\/compact Self-compaction requested by this session/);
    expect(prompts[1]).toMatch(/^\[Self-compaction resume\]/);
    const stored = pending.readPendingSwitch(registry.getSession(me))!;
    expect(stored).toMatchObject({ conversation: "new", compactionQueued: true, handoff: { goal: "Ship it", next: "open the PR" } });
    expect(stored.claimedAt).toBe(registry.getSession(me)!.transportMeta?.selfCompactionAt);
    // Scheduling moves nothing: the session still runs where it was until its resume turn starts.
    expect(registry.getSession(me)!.claudeConfigDir).toBeNull();
    expect(deliveries(me)).toEqual([{ status: "accepted" }]);
  });

  it("is a conversation continued in place for a model-only switch on Claude, and a new one for another engine", async () => {
    const same = await post(newSession(), { model: "sonnet" });
    expect(same.body.switch).toMatchObject({ conversation: "same", compaction: "queued", to: { engine: "claude", model: "sonnet" } });
    const other = await post(newSession(), { engine: "codex" });
    expect(other.status).toBe(202);
    expect(other.body.switch).toMatchObject({ conversation: "new", compaction: "queued", to: { engine: "codex" } });
  });

  it("schedules a switch from an engine with no compaction (codex, opencode run mode) with the compaction skipped, while a plain call still gets 409", async () => {
    const codex = newSession({ engine: "codex", model: "gpt-5.5" });
    const res = await post(codex, { engine: "claude" });
    expect(res.status).toBe(202);
    expect(res.body.switch).toMatchObject({ conversation: "new", compaction: "skipped", from: { engine: "codex" }, to: { engine: "claude" } });
    expect(queuedPrompts(codex)).toHaveLength(1);
    expect(queuedPrompts(codex)[0]).toMatch(/^\[Self-compaction resume\]/);
    expect(pending.readPendingSwitch(registry.getSession(codex))).toMatchObject({ compactionQueued: false });

    const plainCodex = newSession({ engine: "codex", model: "gpt-5.5" });
    expect((await request("POST", "/api/compactions", { headers: asSession(plainCodex), body: HANDOFF })).status).toBe(409);
    expect(queuedPrompts(plainCodex)).toEqual([]);

    mode = "run";
    const oc = newSession({ engine: "opencode", model: "p/m" });
    const fromRunMode = await post(oc, { engine: "claude" });
    expect(fromRunMode.status).toBe(202);
    expect(fromRunMode.body.switch).toMatchObject({ compaction: "skipped" });
    const plainOc = newSession({ engine: "opencode", model: "p/m" });
    expect((await request("POST", "/api/compactions", { headers: asSession(plainOc), body: HANDOFF })).status).toBe(409);
  });

  it("a model change on an engine with no compaction is a new conversation with the compaction skipped, never one continued in place", async () => {
    const codex = newSession({ engine: "codex", model: "gpt-5.5" });
    const res = await post(codex, { model: "gpt-5.4" });
    expect(res.status).toBe(202);
    expect(res.body.switch).toMatchObject({ conversation: "new", compaction: "skipped", to: { engine: "codex", model: "gpt-5.4" } });
  });

  it("ignores a sessionId in the body: the caller's own session is the one asked about", async () => {
    const me = newSession();
    const other = newSession();
    const res = await post(me, { profile: "alpha", sessionId: other });
    expect(res.status).toBe(202);
    expect(res.body.sessionId).toBe(me);
    expect(queuedPrompts(other)).toEqual([]);
    expect(pending.readPendingSwitch(registry.getSession(other))).toBeUndefined();
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeDefined();
  });

  it("lets a department-scoped session change profile (alpha and back to own login), and refuses another engine", async () => {
    const scoped = newSession({ employee: "lab-dev" });
    expect((await post(scoped, { profile: "alpha" })).status).toBe(202);
    const back = newSession({ employee: "lab-dev", claudeConfigDir: alpha.dir });
    const home = await post(back, { profile: "" });
    expect(home.status).toBe(202);
    expect(home.body.switch).toMatchObject({ to: { profile: null } });
    const refused = await post(newSession({ employee: "lab-dev" }), { engine: "codex" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("not-allowed");
  });
});

describe("target refusals take no claim and change nothing", () => {
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ["an unknown engine", { engine: "nonesuch" }, 400, "invalid-target"],
    ["the list request", { engine: "?" }, 400, "invalid-target"],
    ["an unknown model", { model: "nonesuch" }, 400, "invalid-target"],
    ["an unknown profile", { profile: "gamma" }, 400, "invalid-target"],
    ["a profile on another engine", { engine: "codex", profile: "alpha" }, 400, "invalid-target"],
    ["a Claude profile spelt as an engine", { engine: "claude:alpha" }, 400, "invalid-target"],
    ["its own target", { model: "opus" }, 400, "same-target"],
  ];
  it.each(cases)("%s", async (_name, body, status, code) => {
    const me = newSession();
    const before = snapshot(me);
    const res = await post(me, body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(Object.keys(res.body).sort()).toEqual(["code", "error", "targets"]);
    expect(snapshot(me)).toEqual(before);
    expect(before.claim).toBeNull();
    // No claim was taken, so a valid call goes straight through.
    expect((await post(me, { profile: "alpha" })).status).toBe(202);
  });

  it("an uninstalled engine is refused as invalid", async () => {
    uninstalled.add("codex");
    const me = newSession();
    const res = await post(me, { engine: "codex" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not installed where this session runs/);
    expect((res.body.targets as { engines: Array<{ name: string }> }).engines.map((e) => e.name)).not.toContain("codex");
  });

  it("a scoped session to another engine, and a remote employee's session to a local profile, are 403 not-allowed", async () => {
    for (const [employee, body] of [["lab-dev", { engine: "codex" }], ["far-dev", { profile: "alpha" }]] as const) {
      const me = newSession({ employee });
      const before = snapshot(me);
      const res = await post(me, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("not-allowed");
      expect(Object.keys(res.body).sort()).toEqual(["code", "error", "targets"]);
      expect(snapshot(me)).toEqual(before);
    }
  });

  it("a target out of allowance is 409 target-exhausted with the window's end, `until`, and the list", async () => {
    const me = newSession();
    const until = exhaust(`claude:${alpha.key}`);
    const before = snapshot(me);
    const res = await post(me, { profile: "alpha" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "target-exhausted", until });
    expect(Object.keys(res.body).sort()).toEqual(["code", "error", "targets", "until"]);
    expect(res.body.error).toMatch(/resets at /);
    expect(snapshot(me)).toEqual(before);
  });

  it("every refusal's error ends with the rendered list, bounded, with the structured list beside it", async () => {
    const me = newSession();
    exhaust(`claude:${alpha.key}`);
    const res = await post(me, { engine: "?" });
    const error = res.body.error as string;
    expect(error.length).toBeLessThanOrEqual(1_800);
    expect(error).toMatch(/^unknown engine "\?" — call again with one of these\. Now: Claude · own login · Opus/);
    expect(error).toContain("claude: profiles \"\" (own login), alpha (exhausted until");
    expect(error).toContain("beta");
    expect(error).toMatch(/models opus, sonnet, .*haiku/);
    expect(error).toContain("codex:");
    const targets = res.body.targets as { current: unknown; engines: Array<{ name: string; defaultModel: string; health: { state: string }; models: unknown[]; profiles?: Array<{ name: string; label: string; health: { state: string; until?: string } }> }> };
    expect(targets.current).toEqual({ engine: "claude", profile: null, model: "opus" });
    const claude = targets.engines.find((e) => e.name === "claude")!;
    expect(claude.profiles!.map((p) => p.name)).toEqual(["", "alpha", "beta"]);
    expect(claude.profiles![0]).toMatchObject({ label: "own login", health: { state: "ok" } });
    expect(claude.profiles![1].health).toMatchObject({ state: "exhausted", until: expect.any(String) });
    expect(claude.models[0]).toMatchObject({ id: "opus", label: expect.any(String) });
    expect(Object.keys(claude).sort()).toEqual(["defaultModel", "health", "models", "name", "profiles"]);
  });

  it("the list for a remote employee's session omits Claude's profiles; for a scoped session it names claude only", async () => {
    const remote = await post(newSession({ employee: "far-dev" }), { engine: "?" });
    const remoteClaude = (remote.body.targets as { engines: Array<{ name: string; profiles?: unknown }> }).engines.find((e) => e.name === "claude")!;
    expect(remoteClaude.profiles).toBeUndefined();
    const scoped = await post(newSession({ employee: "lab-dev" }), { engine: "?" });
    expect((scoped.body.targets as { engines: Array<{ name: string }> }).engines.map((e) => e.name)).toEqual(["claude"]);
  });
});

describe("target before handoff, claim and queue", () => {
  it("answers `engine: \"?\"` with the list even when the handoff is invalid", async () => {
    const me = newSession();
    const res = await request("POST", "/api/compactions", { headers: asSession(me), body: { goal: "g", done: "d", next: "", engine: "?" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid-target");
    expect(res.body.targets).toBeDefined();
  });

  it("an invalid handoff with a valid target is a plain 400 and takes no claim", async () => {
    const me = newSession();
    const res = await request("POST", "/api/compactions", { headers: asSession(me), body: { goal: "g", done: "d", engine: "codex" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.stringMatching(/next is required/) });
    expect(registry.getSession(me)!.transportMeta?.selfCompactionAt).toBeUndefined();
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
  });

  it("a second call inside the cooldown is 429 with retryAt and leaves the first request's pending switch and queue", async () => {
    const me = newSession();
    expect((await post(me, { profile: "alpha" })).status).toBe(202);
    const before = snapshot(me);
    const again = await post(me, { profile: "beta" });
    expect(again.status).toBe(429);
    expect(Object.keys(again.body).sort()).toEqual(["error", "retryAt"]);
    expect(snapshot(me)).toEqual(before);
  });

  it("messages already queued are 409, the claim is given back and no pending switch is left", async () => {
    const me = newSession();
    expect((await request("POST", `/api/sessions/${me}/message`, { headers: { authorization: "Bearer test-token" }, body: { message: "child says hi", role: "notification" } })).status).toBe(200);
    const res = await post(me, { profile: "alpha" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already queued.*then call compact_session again/);
    expect(registry.getSession(me)!.transportMeta?.selfCompactionAt).toBeUndefined();
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
  });

  it("a stopped session and a terminal session are 409, a non-session caller 403, an unknown session 404", async () => {
    const halted = newSession();
    stopped.markSessionStopped(halted);
    const res = await post(halted, { profile: "alpha" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stopped");
    expect(registry.getSession(halted)!.transportMeta?.selfCompactionAt).toBeUndefined();
    expect((await request("POST", "/api/compactions", { headers: { authorization: "Bearer test-token" }, body: { ...HANDOFF, profile: "alpha" } })).status).toBe(403);
    expect((await request("POST", "/api/compactions", { headers: asSession("no-such-session"), body: { ...HANDOFF, profile: "alpha" } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("a stop gives up on the resume for good", () => {
  it("the dead-lettered resume withdraws its switch, and a request that is not a self-compaction resume does not", async () => {
    const { deliverClaimedSessionDelivery } = await import("../../sessions/callbacks.js");
    const me = newSession();
    failLoopback = (index) => index === 1;
    expect((await post(me, { profile: "alpha" })).body.resume).toBe("retrying");
    failLoopback = undefined;
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeDefined();
    // Some other delivery for the session is dead-lettered by a stop: the switch stands.
    const stray = registry.claimSessionDelivery({ targetSessionId: me, sourceKind: "session", sourceId: me, sourceAttempt: "x:1", sourceOutcome: "done", sourceVersion: 1, deliveryKind: "parent-callback", payload: { message: "hi", displayMessage: "hi" } }).delivery;
    stopped.markSessionStopped(me);
    await deliverClaimedSessionDelivery(stray.id);
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeDefined();
    // The resume itself is dead-lettered by the stop: the switch goes with it.
    const resume = db.initDb().prepare("SELECT id FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = 'self-compaction-resume'").get(me) as { id: string };
    // The retry comes due.
    db.initDb().prepare("UPDATE callback_deliveries SET next_attempt_at = last_attempt_at WHERE id = ?").run(resume.id);
    await deliverClaimedSessionDelivery(resume.id);
    expect(registry.getSessionDelivery(resume.id)?.status).toBe("dead_letter");
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
  });
});

describe("failures after the claim", () => {
  it("a /compact turn that cannot be queued is 502, gives the claim back and removes the pending switch", async () => {
    const me = newSession();
    failLoopback = (index) => index === 0;
    const res = await post(me, { profile: "alpha" });
    expect(res.status).toBe(502);
    expect(registry.getSession(me)!.transportMeta?.selfCompactionAt).toBeUndefined();
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
    expect(queuedPrompts(me)).toEqual([]);
    failLoopback = undefined;
    expect((await post(me, { profile: "alpha" })).status).toBe(202);
  });

  it("a resume that cannot be recorded is 500 saying no switch was scheduled: the claim stays, the pending switch goes", async () => {
    const { handleSelfCompactionApi } = await import("../self-compaction-api.js");
    const me = newSession();
    const cap = makeRes();
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ ...HANDOFF, profile: "alpha" }))]), { method: "POST", url: "/api/compactions", headers: { "content-type": "application/json" } });
    await handleSelfCompactionApi(req as unknown as IncomingMessage, cap.res, { method: "POST", pathname: "/api/compactions", url: new URL("http://x/api/compactions") } as never, {
      resolveCaller: () => ({ kind: "session", callerId: me }) as never,
      opencodeMode: () => "server",
      getConfig: () => config,
      enqueueTurn: async () => {},
      deliverResume: async () => { throw new Error("outbox is down"); },
    });
    expect(cap.status).toBe(500);
    const body = JSON.parse(cap.text) as { error: string };
    expect(body.error).toMatch(/compaction is queued and will run, but the resume could not be recorded, so no switch was scheduled \(outbox is down\)\. End your turn with the handoff written out in your reply\./);
    expect(registry.getSession(me)!.transportMeta?.selfCompactionAt).toEqual(expect.any(Number));
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
  });

  it("a stop that lands while the resume is delivered gives the claim back and removes the pending switch", async () => {
    const me = newSession();
    // The first loopback (the /compact turn) is served; the stop is marked before the resume is delivered.
    const original = loopbacks.length;
    expect(original).toBe(0);
    const { handleSelfCompactionApi } = await import("../self-compaction-api.js");
    const cap = makeRes();
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ ...HANDOFF, profile: "alpha" }))]), { method: "POST", url: "/api/compactions", headers: { "content-type": "application/json" } });
    await handleSelfCompactionApi(req as unknown as IncomingMessage, cap.res, { method: "POST", pathname: "/api/compactions", url: new URL("http://x/api/compactions") } as never, {
      resolveCaller: () => ({ kind: "session", callerId: me }) as never,
      opencodeMode: () => "server",
      getConfig: () => config,
      enqueueTurn: async () => {},
      deliverResume: async () => "stopped",
    });
    expect(cap.status).toBe(409);
    expect(registry.getSession(me)!.transportMeta?.selfCompactionAt).toBeUndefined();
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
  });
});
