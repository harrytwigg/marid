import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";

/**
 * A session moving itself, end to end through the real route, outbox, queue rows, turn runner and
 * dispatch (temp home, stub engines that record what they were run with): the compaction turn
 * settles and tells the pending switch how it went, the resume turn starts and applies the switch,
 * and the prompt the new conversation is run with is what the design says. Every path that does
 * not carry a summary lands on the new target with the handoff and a pointer, never the old text.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pending-switch-flow-"));
process.env.JINN_HOME = home;
const OUTSIDE = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const OWN_CONFIG = fs.mkdtempSync(path.join(OUTSIDE, "pending-flow-own-"));
process.env.CLAUDE_CONFIG_DIR = OWN_CONFIG;
fs.writeFileSync(path.join(OWN_CONFIG, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "t", expiresAt: 4_102_444_800_000 } }));
const ALPHA = path.join(OUTSIDE, "pending-flow-alpha");
const BETA = path.join(OUTSIDE, "pending-flow-beta");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));

const { ensureSessionCapability } = await import("../../mcp/identity.js");
const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { claudeProfileFromDir, claudeProjectsDirFor } = await import("../../shared/claude-profile.js");
const { claudeProjectSlug } = await import("../../shared/claude-project-slug.js");
const { JINN_HOME } = await import("../../shared/paths.js");

let api: typeof import("../../gateway/api.js");
let registry: typeof import("../registry.js");
let pending: typeof import("../pending-switch.js");
let dispatch: typeof import("../../gateway/web-session-dispatch.js");
let db: typeof import("../../shared/db.js");

const alpha = claudeProfileFromDir(ALPHA)!;
const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: process.execPath, model: "opus", accounts: { alpha: { configDir: ALPHA }, beta: { configDir: BETA } } },
    codex: { bin: process.execPath, model: "gpt-5.5" },
    opencode: { bin: process.execPath, mode: "server" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/jinn" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  sessions: {},
  mcp: {},
  portal: { setupComplete: true },
} as unknown as JinnConfig;

/* ── What the stub engines are run with, and how a compaction ends ─────────── */

interface Call { engine: string; prompt: string; resume?: string; profile: string | null; model?: string; status?: string }
let runningId = "";
type CompactMode = "ok" | "error" | "limit" | "unconfirmed" | "no-summary" | "too-long" | "throw";
let calls: Call[] = [];
let compactMode: CompactMode = "ok";
let threads = 0;
const SUMMARY = "This session is being continued from a previous conversation. SUMMARY-OF-THE-WORK-SO-FAR";
const EARLIER = "EARLIER-SECRET-TEXT the operator wrote long ago";

function transcriptPath(dir: string | null, id: string): string {
  const projects = claudeProjectsDirFor(dir ? claudeProfileFromDir(dir) : null);
  return path.join(projects, claudeProjectSlug(JINN_HOME), `${id}.jsonl`);
}

/** The transcript Claude Code leaves after a manual /compact: boundary, then the marked summary. */
function writeCompaction(dir: string | null, id: string, text: string): void {
  const file = transcriptPath(dir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 9000, postTokens: 1200 }, timestamp: at },
    { type: "user", isCompactSummary: true, message: { role: "user", content: text }, timestamp: at },
  ];
  fs.appendFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function compactResult(name: string, opts: EngineRunOpts): EngineResult {
  const sessionId = opts.resumeSessionId ?? "thread-none";
  const confirmed = { sessionId, result: "", numTurns: 1, compaction: { preTokens: 9000, postTokens: 1200 } };
  switch (compactMode) {
    case "throw": throw new Error("the engine process died");
    case "error": return { sessionId, result: "", numTurns: 1, error: "the engine failed mid-summary" };
    case "limit": return { sessionId, result: "", numTurns: 1, error: "You've hit your limit · resets 3pm", rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
    case "unconfirmed": return { sessionId, result: "", numTurns: 1 };
    case "no-summary": return confirmed;
    case "too-long":
    case "ok": {
      const text = compactMode === "too-long" ? `${SUMMARY} ${"x".repeat(24_001)}` : SUMMARY;
      if (name === "claude") writeCompaction(opts.claudeProfile?.dir ?? null, sessionId, text);
      return name === "opencode" ? { ...confirmed, compactionSummary: text } : confirmed;
    }
  }
}

function stubEngine(name: string): Engine {
  return {
    name,
    async run(opts: EngineRunOpts) {
      calls.push({ engine: name, prompt: opts.prompt, resume: opts.resumeSessionId, profile: opts.claudeProfile?.dir ?? null, model: opts.model, status: registry.getSession(runningId)?.status });
      if (/^\/compact\b/.test(opts.prompt)) return compactResult(name, opts);
      threads += 1;
      return { sessionId: opts.resumeSessionId ?? `thread-${name}-${threads}`, result: "carried on" };
    },
    isAlive: () => true,
    isTurnRunning: () => false,
    kill: () => {},
    killAll: () => {},
  } as unknown as Engine;
}
const engines = new Map<string, Engine>();

/* ── The gateway around it ───────────────────────────────────────────────── */

const emitted: Array<[string, Record<string, unknown>]> = [];
const noQueue = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {},
  holdForCallbackDrain: () => {}, releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0,
  getRowlessWaitingCount: () => 0, getTransportState: (_key: string, status: string) => status,
};
const running: Promise<unknown>[] = [];
const runningQueue = { ...noQueue, enqueue: async (_key: string, fn: () => Promise<unknown>) => { const turn = fn(); running.push(turn); await turn; } };
const makeContext = (queue: unknown) => ({
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  gatewayBootId: "boot-1",
  emit: (event: string, payload: Record<string, unknown>) => { emitted.push([event, payload]); },
  sessionManager: { getEngines: () => engines, getEngine: (name: string) => engines.get(name), getQueue: () => queue },
}) as unknown as import("../../gateway/api.js").ApiContext;
const parkContext = makeContext(noQueue);
const runContext = makeContext(runningQueue);

async function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  let status = 200;
  let raw = "";
  const body = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = Object.assign(Readable.from(body), { method, url, headers: { host: "gw.test", "content-type": "application/json", ...opts.headers } });
  const res = {
    writeHead(next: number) { status = next; return this; }, setHeader() { return this; }, getHeader() { return undefined; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); }, write(chunk: Buffer | string) { raw += chunk.toString(); return true; },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as unknown as IncomingMessage, res, parkContext);
  return { status, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../registry.js");
  pending = await import("../pending-switch.js");
  dispatch = await import("../../gateway/web-session-dispatch.js");
  db = await import("../../shared/db.js");
  const { refreshOrg } = await import("../../gateway/org-registry.js");
  db.initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  refreshOrg(config);
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const out = await request(init?.method ?? "GET", url.pathname + url.search, { headers: { authorization: "Bearer test-token" }, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
  for (const name of ["claude", "codex", "opencode"]) engines.set(name, stubEngine(name));
}, 60_000);

afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  calls = [];
  compactMode = "ok";
  emitted.length = 0;
  running.length = 0;
  // A compaction that hits a limit files the account as spent; that must not carry into the next test.
  fs.rmSync(path.join(home, "tmp", "engine-health.json"), { force: true });
  (config.engines.claude as { accounts: Record<string, unknown> }).accounts = { alpha: { configDir: ALPHA }, beta: { configDir: BETA } };
  db.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM callback_deliveries; DELETE FROM sessions;");
});

/* ── Driving it ──────────────────────────────────────────────────────────── */

const HANDOFF = { goal: "Ship the feature", done: "built it", next: "open the PR", context: "branch feat/x" };
let counter = 0;

/** A session mid-turn on a conversation of its own, with an earlier message in its history. */
function startSession(over: Partial<Parameters<typeof registry.createSession>[0]> = {}) {
  counter += 1;
  const engine = over.engine ?? "claude";
  const s = registry.createSession({ engine, source: "web", sourceRef: `flow-${counter}`, model: engine === "claude" ? "opus" : (engine === "codex" ? "gpt-5.5" : "p/m"), employee: "plain-dev", ...over });
  registry.recordEngineSessionId(s.id, engine, `thread-old-${counter}`, { model: s.model ?? undefined });
  registry.insertMessage(s.id, "user", EARLIER);
  registry.updateSession(s.id, { status: "running", attemptToken: `ask-${counter}` } as never);
  return s.id;
}

const asSession = (id: string) => ({ "x-jinn-tool-call": "jinn-mcp", "x-jinn-caller-session": id, "x-jinn-session-capability": ensureSessionCapability(id)! });
const schedule = async (id: string, body: Record<string, unknown>) => {
  const res = await request("POST", "/api/compactions", { headers: asSession(id), body: { ...HANDOFF, ...body } });
  if (res.status !== 202) throw new Error(`schedule refused (${res.status}): ${JSON.stringify(res.body)}`);
  return res;
};
const rows = (id: string) => db.initDb()
  .prepare("SELECT id, prompt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY position ASC, created_at ASC")
  .all(id) as Array<{ id: string; prompt: string }>;

/** Run one queued turn through dispatch, as the queue would, and wait for it to settle. */
async function runRow(id: string, row: { id: string; prompt: string }): Promise<void> {
  runningId = id;
  const session = registry.getSession(id)!;
  const before = running.length;
  dispatch.dispatchWebSessionRun(session, row.prompt, engines.get(session.engine)!, runContext, { queueItemId: row.id });
  await vi.waitFor(() => expect(running.length).toBeGreaterThan(before));
  await Promise.all(running);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** The asking turn ends, the compaction (when one was queued) runs, then the resume. */
async function runSwitch(id: string, opts: { skipCompaction?: boolean } = {}) {
  registry.updateSession(id, { status: "idle" });
  const queued = rows(id);
  const resume = queued[queued.length - 1];
  if (queued.length > 1 && !opts.skipCompaction) await runRow(id, queued[0]);
  await runRow(id, resume);
  return { resume, session: registry.getSession(id)! };
}

const resumeCall = () => calls[calls.length - 1];
const lastSwitch = (id: string) => registry.getSession(id)!.transportMeta?.lastSwitch as Record<string, unknown> | undefined;
const notices = (id: string) => registry.getMessages(id).filter((m) => m.role === "notification").map((m) => m.content);

describe("the summary carries the conversation over", () => {
  it("moves a new conversation onto the target and opens it on the summary then the handoff, never the old text", async () => {
    const me = startSession();
    const oldThread = registry.getSession(me)!.engineSessionId;
    await schedule(me, { profile: "alpha" });
    const { session } = await runSwitch(me);

    // The compaction ran on the own login first; the resume ran on the target, fresh.
    expect(calls.map((c) => [c.prompt.startsWith("/compact"), c.profile])).toEqual([[true, null], [false, alpha.dir]]);
    expect(calls[0].resume).toBe(oldThread);
    const prompt = resumeCall().prompt;
    expect(resumeCall().resume).toBeUndefined();
    expect(prompt).toContain("[Session switch resume]");
    expect(prompt).toMatch(/It now runs on Claude · alpha · Opus/);
    expect(prompt).toContain("This is a new conversation. The summary of the previous one follows, then your handoff.");
    expect(prompt).toContain("SUMMARY-OF-THE-WORK-SO-FAR");
    expect(prompt).toContain("## Goal\nShip the feature");
    expect(prompt).toContain("## Next\nopen the PR");
    expect(prompt).toContain(`read_session {sessionId: "${me}"}`);
    expect(prompt).not.toContain(EARLIER);

    // The switch is written inside the running turn without touching its status, so that turn still settles.
    expect(resumeCall().status).toBe("running");
    expect(session.claudeConfigDir).toBe(alpha.dir);
    expect(session.status).toBe("idle");
    expect(session.lastError).toBeNull();
    expect(session.transportMeta?.pendingSwitch).toBeUndefined();
    expect(session.transportMeta?.engineSyncMode).toBeUndefined();
    expect(lastSwitch(me)).toMatchObject({ by: "session", applied: true, carryOver: "summary", from: { profile: null }, to: { profile: "alpha" } });
    expect(notices(me).some((text) => /Switched from Claude · own login · Opus.* to Claude · alpha · Opus.* \(requested by this session; carried over by compaction summary\)/.test(text))).toBe(true);
    expect(emitted.some(([event, payload]) => event === "session:updated" && payload.sessionId === me)).toBe(true);
  });

  it("retires the left conversation: a return to the own login starts fresh, not on the compacted thread", async () => {
    const me = startSession();
    const oldThread = registry.getSession(me)!.engineSessionId;
    await schedule(me, { profile: "alpha" });
    await runSwitch(me);
    const slots = registry.getSession(me)!.engineSessions ?? {};
    expect(JSON.stringify(slots)).not.toContain(oldThread!);
    // The operator comes back to the own login: nothing to resume there.
    const { switchSessionTarget } = registry;
    switchSessionTarget(me, { engine: "claude", claudeConfigDir: null, model: "opus", leftConversation: "park", sync: "pointer" });
    expect(registry.getSession(me)!.engineSessionId).toBeNull();
  });

  it("carries the summary opencode wrote when the compaction ran on opencode", async () => {
    const me = startSession({ engine: "opencode" });
    await schedule(me, { engine: "claude" });
    await runSwitch(me);
    expect(calls[0].engine).toBe("opencode");
    const prompt = resumeCall().prompt;
    expect(resumeCall().engine).toBe("claude");
    expect(prompt).toContain("SUMMARY-OF-THE-WORK-SO-FAR");
    expect(prompt).toContain("This is a new conversation. The summary of the previous one follows");
    expect(prompt).not.toContain(EARLIER);
    expect(registry.getSession(me)!.engine).toBe("claude");
  });
});

describe("every failure lands on the new target with the handoff and a pointer", () => {
  const phrases: Array<[CompactMode, string, string]> = [
    ["error", "error", "the compaction failed (an error)"],
    ["limit", "usage-limit", "the compaction failed (usage limit)"],
    ["unconfirmed", "unconfirmed", "the compaction failed (it could not be confirmed)"],
    ["no-summary", "no-summary", "the compaction failed (no summary was produced)"],
    ["too-long", "summary-too-long", "the compaction failed (the summary was too long)"],
    ["throw", "error", "the compaction failed (an error)"],
  ];
  it.each(phrases)("%s", async (mode, reason, phrase) => {
    compactMode = mode;
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    const { session } = await runSwitch(me);

    const prompt = resumeCall().prompt;
    expect(prompt).toContain("This is a new conversation and the previous one could not be summarised");
    expect(prompt).toContain(`read_session {sessionId: "${me}", last: 100}`);
    expect(prompt).toContain("## Next\nopen the PR");
    // SC-008: neither the old message text nor a summary is pasted.
    expect(prompt).not.toContain(EARLIER);
    expect(prompt).not.toContain("SUMMARY-OF-THE-WORK-SO-FAR");
    expect(resumeCall().resume).toBeUndefined();
    expect(session.claudeConfigDir).toBe(alpha.dir);
    expect(session.status).toBe("idle");
    expect(lastSwitch(me)).toMatchObject({ applied: true, carryOver: "manual-handover", reason });
    expect(notices(me).some((text) => text.includes(`${phrase}, so the new conversation was told where to read the history`))).toBe(true);
  });

  it("no outcome (the compaction never settled): the same manual handover", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    const { session } = await runSwitch(me, { skipCompaction: true });
    expect(calls.map((c) => c.prompt.startsWith("/compact"))).toEqual([false]);
    expect(resumeCall().prompt).toContain("could not be summarised (the compaction failed (it did not finish))");
    expect(resumeCall().prompt).not.toContain(EARLIER);
    expect(session.claudeConfigDir).toBe(alpha.dir);
    expect(lastSwitch(me)).toMatchObject({ carryOver: "manual-handover", reason: "no-outcome" });
  });

  it("an engine with no compaction (codex) is not-supported, and nothing is run for it", async () => {
    const me = startSession({ engine: "codex" });
    expect((await schedule(me, { engine: "claude" })).body.switch).toMatchObject({ compaction: "skipped" });
    const { session } = await runSwitch(me);
    expect(calls).toHaveLength(1);
    expect(calls[0].engine).toBe("claude");
    expect(calls[0].prompt).toContain("could not be summarised (Codex has no compaction)");
    expect(calls[0].prompt).not.toContain(EARLIER);
    expect(session.engine).toBe("claude");
    expect(lastSwitch(me)).toMatchObject({ carryOver: "manual-handover", reason: "not-supported" });
  });

  it("the left Claude transcript's path rides on the pointer for an unscoped session", async () => {
    compactMode = "error";
    const me = startSession();
    const thread = registry.getSession(me)!.engineSessionId!;
    const file = transcriptPath(null, thread);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    await schedule(me, { profile: "alpha" });
    await runSwitch(me);
    expect(resumeCall().prompt).toContain(`last: 100} and ${file} before resuming`);
    expect(lastSwitch(me)).toMatchObject({ leftTranscript: file });
  });
});

describe("a model-only switch keeps the conversation", () => {
  it("compacts in place and resumes the same thread on the new model", async () => {
    const me = startSession();
    const thread = registry.getSession(me)!.engineSessionId!;
    const res = await schedule(me, { model: "sonnet" });
    expect(res.body.switch).toMatchObject({ conversation: "same" });
    const { session } = await runSwitch(me);
    expect(calls.map((c) => [c.prompt.startsWith("/compact"), c.resume, c.model])).toEqual([[true, thread, "opus"], [false, thread, "sonnet"]]);
    expect(resumeCall().prompt).toContain("Your context was compacted in place.");
    expect(resumeCall().prompt).not.toContain("SUMMARY-OF-THE-WORK-SO-FAR");
    expect(session.model).toBe("sonnet");
    expect(session.claudeConfigDir).toBeNull();
    expect(lastSwitch(me)).toMatchObject({ applied: true, carryOver: "same-conversation" });
    expect(lastSwitch(me)!.reason).toBeUndefined();
  });

  it("needs no summary: a confirmed in-place compaction is the same conversation even when the transcript holds none", async () => {
    compactMode = "no-summary";
    const me = startSession();
    await schedule(me, { model: "sonnet" });
    const { session } = await runSwitch(me);
    expect(resumeCall().prompt).toContain("Your context was compacted in place.");
    expect(session.model).toBe("sonnet");
    expect(lastSwitch(me)).toMatchObject({ carryOver: "same-conversation" });
    expect(lastSwitch(me)!.reason).toBeUndefined();
  });

  it("still changes the model when the compaction failed, and says the context was not compacted", async () => {
    compactMode = "error";
    const me = startSession();
    await schedule(me, { model: "sonnet" });
    const { session } = await runSwitch(me);
    expect(resumeCall().prompt).toContain("Your context could not be compacted (the compaction failed (an error)); the conversation carries on as it was.");
    expect(session.model).toBe("sonnet");
    expect(lastSwitch(me)).toMatchObject({ carryOver: "same-conversation", reason: "error" });
    expect(notices(me).some((text) => text.includes("an error), so the context was not compacted"))).toBe(true);
  });

  it("does not move a session within an account the failed compaction found spent: the switch is declined, not forced", async () => {
    compactMode = "limit";
    const me = startSession();
    await schedule(me, { model: "sonnet" });
    const { session } = await runSwitch(me);
    expect(session.model).toBe("opus");
    expect(lastSwitch(me)).toMatchObject({ applied: false });
    expect(resumeCall().prompt).toMatch(/did not happen \(.*out of allowance/);
  });
});

describe("a session held on a stand-in", () => {
  /** Own login's thread parked, the session running thread-sub on account alpha as a stand-in. */
  async function onStandIn() {
    const { claudeAccountKey } = await import("../../shared/engine-account.js");
    const me = startSession();
    const ownThread = registry.getSession(me)!.engineSessionId!;
    registry.updateSession(me, {
      engineSessionId: "thread-sub",
      engineSessions: { claude: { id: ownThread, model: "opus" }, [claudeAccountKey(alpha)]: { id: "thread-sub", model: "opus" } },
      transportMeta: { engineOverride: { originalAccount: "claude", substituteAccount: claudeAccountKey(alpha), substituteConfigDir: alpha.dir, until: new Date(Date.now() + 3_600_000).toISOString() } } as never,
    });
    return { me, ownThread };
  }

  it("is never a conversation continued in place: the compaction ran on the stand-in's thread, which the apply leaves", async () => {
    const { me, ownThread } = await onStandIn();
    const res = await schedule(me, { model: "sonnet" });
    expect(res.body.switch).toMatchObject({ conversation: "new", compaction: "queued" });
    const { session } = await runSwitch(me);
    expect(calls[0]).toMatchObject({ resume: "thread-sub", profile: alpha.dir });
    const prompt = resumeCall().prompt;
    // A new conversation, opened on the summary of the stand-in's thread: not the parked own-login thread, and not "compacted in place".
    expect(resumeCall().resume).toBeUndefined();
    expect(resumeCall().resume).not.toBe(ownThread);
    expect(prompt).toContain("This is a new conversation. The summary of the previous one follows");
    expect(prompt).not.toContain("compacted in place");
    expect(session.model).toBe("sonnet");
  });

  it("names the engine the compaction ran on, not the one the session returns to, when it had none", async () => {
    const me = startSession({ engine: "codex" });
    registry.updateSession(me, { transportMeta: { engineOverride: { originalEngine: "claude", originalModel: "opus", until: new Date(Date.now() + 3_600_000).toISOString() } } as never });
    registry.updateSession(me, { model: "gpt-5.5" });
    const res = await schedule(me, { model: "sonnet" });
    expect(res.body.switch).toMatchObject({ conversation: "new", compaction: "skipped", from: { engine: "claude" } });
    await runSwitch(me);
    expect(resumeCall().prompt).toContain("(Codex has no compaction)");
    expect(lastSwitch(me)).toMatchObject({ reason: "not-supported", compactedOn: "codex" });
    expect(notices(me).some((text) => text.includes("Codex has no compaction"))).toBe(true);
  });
});

describe("a new conversation on a slot that holds a parked one", () => {
  it("opens fresh there instead of resuming the parked thread the prompt calls new", async () => {
    // Own login's thread parked by an earlier (operator) switch to alpha, where the session has since worked on a thread of its own.
    const me = startSession();
    const parked = registry.getSession(me)!.engineSessionId!;
    registry.switchSessionTarget(me, { engine: "claude", claudeConfigDir: alpha.dir, model: "opus", leftConversation: "park", sync: "none" });
    registry.recordEngineSessionId(me, "claude", "thread-on-alpha", { model: "opus" });
    registry.updateSession(me, { status: "running", attemptToken: "ask-again" } as never);
    expect(JSON.stringify(registry.getSession(me)!.engineSessions)).toContain(parked);
    await schedule(me, { profile: "" });
    const { session } = await runSwitch(me);
    expect(resumeCall().resume).toBeUndefined();
    expect(resumeCall().prompt).toContain("This is a new conversation");
    expect(session.claudeConfigDir).toBeNull();
    expect(JSON.stringify(session.engineSessions)).not.toContain("thread-on-alpha");
    expect(calls.some((c) => c.resume === parked && !c.prompt.startsWith("/compact"))).toBe(false);
  });
});

describe("leaving a profile for another engine, and coming back", () => {
  it("opens the profile fresh with a pointer and no paste, and the own login still resumes its own thread", async () => {
    const { patchSessionTarget } = await import("../../gateway/session-target-patch.js");
    const operator = (body: Record<string, unknown>) => {
      registry.updateSession(me, { status: "idle" });
      const result = patchSessionTarget({ session: registry.getSession(me)!, config, emit: () => {}, body, busy: false });
      expect(result.kind).toBe("switched");
    };
    const me = startSession();
    const ownThread = registry.getSession(me)!.engineSessionId!;
    // The operator moves the chat to alpha, where it works on a thread of its own.
    operator({ profile: "alpha" });
    registry.recordEngineSessionId(me, "claude", "thread-on-alpha", { model: "opus" });
    registry.updateSession(me, { status: "running", attemptToken: "ask-alpha" } as never);

    // The session leaves for codex by its own request; the profile stays on the row for the way back.
    await schedule(me, { engine: "codex" });
    await runSwitch(me);
    expect(registry.getSession(me)!.engine).toBe("codex");
    expect(registry.getSession(me)!.claudeConfigDir).toBe(alpha.dir);

    // Back to claude: alpha opens fresh, told where the history is, nothing pasted.
    operator({ engine: "claude" });
    await runRow(me, { id: "back-to-alpha", prompt: "carry on please" });
    const onAlpha = resumeCall();
    expect(onAlpha).toMatchObject({ engine: "claude", profile: alpha.dir });
    expect(onAlpha.resume).toBeUndefined();
    expect(onAlpha.prompt).toContain("read_session");
    expect(onAlpha.prompt).not.toContain(EARLIER);
    expect(onAlpha.prompt).not.toContain(ownThread);

    // And to the own login: its parked thread resumes.
    operator({ profile: null });
    await runRow(me, { id: "back-to-own", prompt: "and now here" });
    expect(resumeCall()).toMatchObject({ engine: "claude", profile: null, resume: ownThread });
  });
});

describe("a switch that can no longer happen", () => {
  it("a target that is no longer valid at apply: the session stays, is told so, and the notice says it did not happen", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    delete (config.engines.claude as { accounts: Record<string, unknown> }).accounts.alpha;
    const { session } = await runSwitch(me);
    expect(session.claudeConfigDir).toBeNull();
    expect(session.status).toBe("idle");
    expect(session.transportMeta?.pendingSwitch).toBeUndefined();
    const prompt = resumeCall().prompt;
    expect(prompt).toContain("The switch to Claude · alpha");
    expect(prompt).toContain("did not happen (unknown Claude profile \"alpha\"");
    expect(prompt).toMatch(/you are still on Claude · own login · Opus.*\. Your context was compacted\./);
    expect(prompt).toContain("## Next\nopen the PR");
    expect(resumeCall().resume).toBe(calls[0].resume);
    expect(lastSwitch(me)).toMatchObject({ applied: false });
    expect(notices(me).some((text) => /Switch to Claude · alpha .* did not happen: unknown Claude profile "alpha".*Still on Claude · own login/.test(text))).toBe(true);
  });

  it("the session's own target changed (a model set by the operator): not applied, and its context stays", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    registry.updateSession(me, { model: "sonnet" });
    const { session } = await runSwitch(me);
    expect(session.claudeConfigDir).toBeNull();
    expect(session.model).toBe("sonnet");
    expect(resumeCall().prompt).toContain("the session was moved to another target meanwhile");
    expect(lastSwitch(me)).toMatchObject({ applied: false });
  });

  it("an operator's switch after the call removes the pending switch: the resume runs as a plain resume", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    registry.updateSession(me, { status: "idle" });
    const operatorSwitch = (await import("../../gateway/session-target-patch.js")).patchSessionTarget;
    const result = operatorSwitch({ session: registry.getSession(me)!, config, emit: () => {}, body: { profile: "beta" }, busy: false });
    expect(result.kind).toBe("switched");
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
    const queued = rows(me);
    await runRow(me, queued[queued.length - 1]);
    // The resume payload as queued, behind the operator's own history pointer.
    expect(resumeCall().prompt).toContain("[Self-compaction resume]");
    expect(resumeCall().prompt).not.toContain("[Session switch resume]");
    const session = registry.getSession(me)!;
    expect(session.claudeConfigDir).toBe(claudeProfileFromDir(BETA)!.dir);
    expect(lastSwitch(me)).toMatchObject({ by: "operator" });
  });

  it("a stale resume (one whose claim is not the pending switch's) runs as a plain resume and leaves the pending switch alone", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    const stored = pending.readPendingSwitch(registry.getSession(me))!;
    pending.writePendingSwitch(me, { ...stored, claimedAt: stored.claimedAt + 1 });
    const { session } = await runSwitch(me);
    expect(resumeCall().prompt).toMatch(/^\[Self-compaction resume\]/);
    expect(session.claudeConfigDir).toBeNull();
    expect(pending.readPendingSwitch(session)).toBeDefined();
  });
});

describe("stops", () => {
  it("a stop between the call and the resume removes the pending switch, and a later operator /compact records nothing", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    registry.updateSession(me, { status: "idle" });
    const { stopSession } = await import("../../gateway/session-stop.js");
    stopSession(runContext, registry.getSession(me)!, "idle");
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
    // The operator types /compact: it is an ordinary compaction, no switch is recorded or applied.
    const { clearSessionStopped } = await import("../stopped-marker.js");
    clearSessionStopped(me);
    await runRow(me, { id: "operator-compact", prompt: "/compact keep going" });
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
    expect(registry.getSession(me)!.claudeConfigDir).toBeNull();
  });
});

describe("where the switched turn runs", () => {
  it("runs headless on its new engine, not on the terminal view the dispatch picked for the engine it left", async () => {
    const me = startSession();
    await schedule(me, { engine: "codex" });
    registry.updateSession(me, { status: "idle" });
    const queued = rows(me);
    await runRow(me, queued[0]);
    const viewRuns: string[] = [];
    const view = (name: string) => ({ ...stubEngine(name), async run(opts: EngineRunOpts) { viewRuns.push(name); return { sessionId: "view-thread", result: `view ${opts.prompt.length}` }; } }) as unknown as Engine;
    const viewContext = { ...runContext, ptyViewEngines: { claude: engines.get("claude"), codex: view("codex") } } as unknown as import("../../gateway/api.js").ApiContext;
    const session = registry.getSession(me)!;
    const before = running.length;
    dispatch.dispatchWebSessionRun(session, queued[1].prompt, engines.get("claude")!, viewContext, { queueItemId: queued[1].id });
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(before));
    await Promise.all(running);
    expect(viewRuns).toEqual([]);
    expect(resumeCall().engine).toBe("codex");
  });
});

describe("recording the outcome", () => {
  const turn = (id: string, prompt: string, startedAt: number) => ({ sessionId: id, prompt, startedAt });

  it("records once, only for the switch's own compaction after its claim, and never for an operator's /compact", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    const stored = pending.readPendingSwitch(registry.getSession(me))!;
    const own = `/compact Self-compaction requested by this session mid-task. Current goal: x`;
    // An operator's /compact has no focus line; a turn that began before the claim is an earlier one.
    expect(pending.recordCompactionOutcome(turn(me, "/compact keep the goal", stored.claimedAt + 5), { ok: false, reason: "error" })).toBe(false);
    expect(pending.recordCompactionOutcome(turn(me, own, stored.claimedAt - 5), { ok: false, reason: "error" })).toBe(false);
    expect(pending.readPendingSwitch(registry.getSession(me))!.compaction).toBeUndefined();
    expect(pending.recordCompactionOutcome(turn(me, own, stored.claimedAt + 5), { ok: true, summary: "s" })).toBe(true);
    // The first outcome stands.
    expect(pending.recordCompactionOutcome(turn(me, own, stored.claimedAt + 6), { ok: false, reason: "error" })).toBe(false);
    expect(pending.readPendingSwitch(registry.getSession(me))!.compaction).toEqual({ ok: true, summary: "s" });
  });

  it("records nothing, and does not throw, when no switch is pending", () => {
    const me = startSession();
    expect(pending.recordCompactionOutcome(turn(me, "/compact Self-compaction requested by this session mid-task.", Date.now()), { ok: false, reason: "error" })).toBe(false);
  });
});

describe("stopping an interrupted session", () => {
  it("keeps the pending switch withdrawn even when the stop rewrites the row's restart mark from the row it was handed", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    const { RESTART_RESUME_META_KEY } = registry;
    registry.updateSession(me, { status: "interrupted", transportMeta: { ...registry.getSession(me)!.transportMeta, [RESTART_RESUME_META_KEY]: new Date().toISOString() } as never });
    const { stopSession } = await import("../../gateway/session-stop.js");
    const handed = registry.getSession(me)!;
    expect(pending.readPendingSwitch(handed)).toBeDefined();
    stopSession(runContext, handed, "interrupted");
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
  });
});

describe("a stop on an already stopped session", () => {
  it("still reports that it changed something when it withdrew a switch", async () => {
    const me = startSession();
    registry.updateSession(me, { status: "idle" });
    const { stopSession } = await import("../../gateway/session-stop.js");
    const stopped = await import("../stopped-marker.js");
    stopped.markSessionStopped(me);
    const stored = { claimedAt: 1, from: {}, to: {}, conversation: "new" as const, compactionQueued: true, handoff: HANDOFF };
    pending.writePendingSwitch(me, stored as never);
    expect(stopSession(runContext, registry.getSession(me)!, "idle").changed).toBe(true);
    expect(pending.readPendingSwitch(registry.getSession(me))).toBeUndefined();
    expect(stopSession(runContext, registry.getSession(me)!, "idle").changed).toBe(false);
  });
});

describe("what the apply clears", () => {
  it("drops a standing engine override and fallback run, and the resume still settles", async () => {
    const me = startSession();
    registry.updateSession(me, { transportMeta: { fallbackRun: { hop: 1 }, fallbackHops: 2 } as never });
    await schedule(me, { profile: "alpha" });
    const { session } = await runSwitch(me);
    expect(session.transportMeta?.fallbackRun).toBeUndefined();
    expect(session.transportMeta?.fallbackHops).toBe(2);
    expect(session.status).toBe("idle");
    expect(session.attemptOutcome).not.toBe("failed");
  });

  it("is the same on a restart: the pending switch is on the row and the dispatch entry applies it", async () => {
    const me = startSession();
    await schedule(me, { profile: "alpha" });
    registry.updateSession(me, { status: "idle" });
    // No in-memory state carries over: only the row, the queue rows and the delivery do.
    const queued = rows(me);
    await runRow(me, queued[0]);
    await runRow(me, queued[1]);
    expect(resumeCall().prompt).toContain("[Session switch resume]");
    expect(registry.getSession(me)!.claudeConfigDir).toBe(alpha.dir);
  });
});
