import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CronJob, EngineLimitEngineSnapshot, EngineLimitsResponse, JinnConfig, Session } from "../../shared/types.js";
import type { StartTodoDispatcherResult } from "../../gateway/todo-dispatch.js";
import type { BoardTodo } from "../board.js";
import type { CapacitySnapshot } from "../snapshot.js";
import type { WalkTurn, WalkTurnResult } from "../walk.js";
import type { LinkState } from "../pr-state.js";

/**
 * The board walk end to end on a throwaway instance: a real Todo store, a real
 * rules file, and a stand-in for the model that decides from the prompt alone —
 * the board and the snapshot the gateway built — the way the shipped rules
 * read. So these tests hold the plumbing: the facts a gate hangs on reach the
 * prompt, the answer is carried out against the Todo's real state, the switches
 * are enforced in code, and every tick is logged with its reasons.
 */

// The default dispatch path is the real Todo Dispatcher start; it is mocked
// only so the test can see the options the walk hands it.
const dispatcherStarts = vi.hoisted(() => [] as Array<{ id: string; opts: Record<string, unknown> }>);
vi.mock("../../gateway/todo-dispatch.js", () => ({
  startTodoDispatcher: (item: { id: string }, _context: unknown, opts: Record<string, unknown>) => {
    dispatcherStarts.push({ id: item.id, opts });
    return { ok: true, status: 201, body: { workItemId: item.id, sessionId: `real-${item.id}`, status: "running", reused: false } };
  },
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-walk-"));
process.env.JINN_HOME = home;

const TEMPLATE = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "template", "board-walk.md"), "utf-8");
const NOW = Date.parse("2026-10-02T12:00:00Z");
const RULES = path.join(home, "board-walk.md");

const m = {} as {
  walk: typeof import("../walk.js");
  store: typeof import("../../work-items/store.js");
  transitions: typeof import("../../work-items/transitions.js");
  relations: typeof import("../../work-items/relations.js");
  labels: typeof import("../../work-items/labels.js");
  comments: typeof import("../../work-items/comments.js");
  stopCause: typeof import("../../work-items/stop-cause.js");
  parkExpiry: typeof import("../../work-items/park-expiry.js");
  boardStore: typeof import("../store.js");
  db: import("better-sqlite3").Database;
};

beforeAll(async () => {
  m.walk = await import("../walk.js");
  m.store = await import("../../work-items/store.js");
  m.transitions = await import("../../work-items/transitions.js");
  m.relations = await import("../../work-items/relations.js");
  m.labels = await import("../../work-items/labels.js");
  m.comments = await import("../../work-items/comments.js");
  m.stopCause = await import("../../work-items/stop-cause.js");
  m.parkExpiry = await import("../../work-items/park-expiry.js");
  m.boardStore = await import("../store.js");
  m.db = (await import("../../shared/db.js")).initDb();
  fs.writeFileSync(RULES, TEMPLATE);
});

afterEach(() => {
  const present = new Set(m.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
  for (const table of ["work_item_claims", "work_item_comments", "work_item_labels", "work_item_dispatch", "work_item_auto_start",
    "work_item_stop_cause", "work_item_blocks", "work_item_relations", "work_item_events", "work_items"]) {
    if (present.has(table)) m.db.exec(`DELETE FROM ${table}`);
  }
  fs.rmSync(m.boardStore.BOARD_WALK_STATE_FILE, { force: true });
  fs.rmSync(m.boardStore.BOARD_WALK_LOG_FILE, { force: true });
  fs.writeFileSync(RULES, TEMPLATE);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const config = { gateway: { port: 7799 }, engines: { default: "claude", claude: {} }, connectors: {}, logging: {} } as unknown as JinnConfig;
const secs = (minutesFromNow: number) => Math.floor((NOW + minutesFromNow * 60_000) / 1000);

function claude(fiveHourUsed: number, fiveHourResetMin = 40): EngineLimitEngineSnapshot {
  return {
    name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [],
    windows: [
      { name: "5h", usedPercent: fiveHourUsed, windowDurationMins: 300, resetsAt: secs(fiveHourResetMin) },
      { name: "7d", usedPercent: 30, windowDurationMins: 10_080, resetsAt: secs(2 * 24 * 60) },
    ],
  };
}

const codex: EngineLimitEngineSnapshot = {
  name: "codex", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [],
  windows: [{ name: "5h", usedPercent: 10, windowDurationMins: 300, resetsAt: secs(200) }],
};

function limits(fiveHourUsed = 15): EngineLimitsResponse {
  return { generatedAt: new Date(NOW).toISOString(), default: "claude", engines: { claude: claude(fiveHourUsed), codex } };
}

function todo(title: string, extra: Partial<Parameters<typeof m.store.createWorkItem>[0]> = {}) {
  return m.store.createWorkItem({ title, status: "backlog", source: "human", ...extra });
}

function blocked(title: string, extra: Partial<Parameters<typeof m.store.createWorkItem>[0]> = {}) {
  const item = todo(title, extra);
  m.transitions.transition(item.id, "blocked", "operator", { human: true });
  return m.store.getWorkItem(item.id)!;
}

function section(prompt: string, heading: string): unknown {
  const start = prompt.indexOf(heading);
  const fence = prompt.indexOf("```json\n", start) + "```json\n".length;
  return JSON.parse(prompt.slice(fence, prompt.indexOf("\n```", fence)));
}

/** The shipped rules, as a model would apply them, reading only the prompt. */
function fakeModel(prompt: string, opts: { startAll?: boolean } = {}): string {
  const todos = section(prompt, "## The board") as BoardTodo[];
  const snapshot = section(prompt, "## Capacity snapshot") as CapacitySnapshot;
  const now = Date.parse(snapshot.now);
  const decisions: Array<Record<string, unknown>> = [];
  for (const item of todos) {
    const date = /not before (\d{4}-\d{2}-\d{2})/.exec(item.body ?? "")?.[1];
    const blocker = item.relations.find((relation) => relation.kind === "blocks" && relation.direction === "in");
    const pr = item.links.find((link) => link.kind === "pull");
    let gateMet: boolean | undefined;
    let reason = "";
    const gates: Array<Record<string, string>> = [];
    if (date) { gateMet = Date.parse(date) <= now; reason = `not before ${date}`; gates.push({ kind: "date", date, quote: `not before ${date}` }); }
    if (blocker) { gateMet = blocker.other.status === "done"; reason = `blocked by ${blocker.other.id} (${blocker.other.status})`; gates.push({ kind: "blocker", id: blocker.other.id }); }
    if (pr) { gateMet = pr.state === "MERGED"; reason = `${pr.url} is ${pr.state}`; gates.push({ kind: "pr", url: pr.url }); }
    if (/stuck/.test(item.title)) {
      decisions.push({ id: item.id, verdict: "stuck", action: "flag", reason: "no change for days; the operator should decide" });
    } else if (gateMet === undefined) {
      continue;
    } else if (item.status === "blocked" && gateMet) {
      decisions.push({ id: item.id, verdict: "ready", action: "release", reason: `gate met: ${reason}`, gates });
    } else if (!gateMet && date && /park/.test(item.title)) {
      decisions.push({ id: item.id, verdict: "gated", action: "park", until: `${date}T00:00:00Z`, reason: `gate open: ${reason}` });
    } else if (!gateMet) {
      decisions.push({ id: item.id, verdict: "gated", action: "none", reason: `gate open: ${reason}` });
    }
  }
  const claude5h = snapshot.engines.find((engine) => engine.name === "claude")?.windows.find((window) => window.name === "5h");
  const operatorLive = (snapshot.operator.lastOperatorSessionActivity?.minutesAgo ?? Infinity) <= 30;
  const ready = todos.filter((item) => item.status === "backlog" && (opts.startAll || !item.noAutoStart)
    && !decisions.some((decision) => decision.id === item.id && decision.verdict === "gated"));
  let start: Array<Record<string, unknown>> = [];
  let why: string;
  if (operatorLive) why = "the operator is live";
  else if ((claude5h?.usedPercent ?? 100) > 50) why = `the five-hour window is at ${claude5h?.usedPercent}%, above the daytime 50% ceiling`;
  else if (snapshot.sessionsHoldingCapacityNow > 0) why = "a session already holds engine capacity";
  else if (ready.length === 0) why = "no ready backlog Todo";
  else {
    start = (opts.startAll ? ready : ready.slice(0, 1)).map((item) => ({ id: item.id, reason: "daytime, the five-hour window lapses in 40 min at 15%", engine: "claude" }));
    why = "allowance about to lapse";
  }
  return "Here is my answer.\n\n```json\n" + JSON.stringify({ todos: decisions, dispatch: { start, reason: why }, summary: `${decisions.length} decisions` }) + "\n```\n";
}

interface Harness {
  walk: import("../walk.js").BoardWalk;
  turns: WalkTurn[];
  dispatched: string[];
}

function open(opts: {
  reply?: (turn: WalkTurn) => WalkTurnResult | Promise<WalkTurnResult>;
  fiveHourUsed?: number;
  sessions?: Session[];
  holding?: number;
  links?: Record<string, string>;
  startAll?: boolean;
  turnTimeoutMs?: number;
  stopped?: string[];
  job?: CronJob;
} = {}): Harness {
  const turns: WalkTurn[] = [];
  const dispatched: string[] = [];
  const walk = m.walk.startBoardWalk({
    getConfig: () => config,
    context: {} as never,
    rulesFile: RULES,
    now: () => NOW,
    scheduleJob: () => opts.job,
    runTurn: async (turn) => {
      turns.push(turn);
      return opts.reply ? opts.reply(turn) : { sessionId: `walk-${turns.length}`, reply: fakeModel(turn.prompt, { startAll: opts.startAll }) };
    },
    ...(opts.turnTimeoutMs ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    stopTurn: (sessionKey) => opts.stopped?.push(sessionKey),
    templateRules: () => TEMPLATE,
    dispatch: (item): StartTodoDispatcherResult => {
      dispatched.push(item.id);
      return { ok: true, status: 201, body: { workItemId: item.id, sessionId: `dispatch-${item.id}`, status: "running", reused: false } };
    },
    resolveLink: async (url, kind): Promise<LinkState> => ({ url, kind, state: opts.links?.[url] ?? "unknown" }),
    sessions: () => opts.sessions ?? [],
    holdingCapacity: () => Array.from({ length: opts.holding ?? 0 }, () => ({ engine: "claude" }) as Session),
    collectClaude: async () => claude(opts.fiveHourUsed ?? 15),
    snapshot: {
      collect: async () => limits(opts.fiveHourUsed ?? 15),
      usageHistory: () => [],
      statuslineMtime: () => undefined,
      startedSince: () => [],
      exhausted: () => false,
    },
  });
  return { walk, turns, dispatched };
}

const status = (id: string) => m.store.getWorkItem(id)!.status;
const walkComments = (id: string) => m.comments.listComments(id).comments.filter((comment) => comment.author === "board-walk");

// ── Readiness ────────────────────────────────────────────────────────────────

describe("board walk readiness", () => {
  it("releases a Todo gated on a past date, and leaves one gated on a future date", async () => {
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    const future = blocked("Send the invoice", { body: "not before 2026-10-10" });
    const h = open();
    const tick = await h.walk.tick();

    expect(tick.outcome).toBe("ok");
    expect(status(past.id)).toBe("backlog");
    expect(status(future.id)).toBe("blocked");
    expect(walkComments(past.id)[0].body).toMatch(/^Board walk: released to the queue\. gate met: not before 2026-09-30/);
    expect(walkComments(future.id)).toEqual([]);
    expect(tick.entries).toEqual(expect.arrayContaining([
      { kind: "release", workItemId: past.id, reason: "gate met: not before 2026-09-30", outcome: "moved to backlog" },
      { kind: "gated", workItemId: future.id, reason: "gate open: not before 2026-10-10", outcome: "left alone" },
    ]));
  });

  it("releases a blocks dependency once the blocker is done, and not while it is open", async () => {
    const blocker = todo("Migrate the database");
    const waiting = blocked("Drop the old columns");
    m.relations.addRelation(blocker.id, waiting.id, "blocks", "operator");
    const h = open();

    await h.walk.tick();
    expect(status(waiting.id)).toBe("blocked");
    const prompt = section(h.turns[0].prompt, "## The board") as BoardTodo[];
    expect(prompt.find((item) => item.id === waiting.id)?.relations).toEqual([
      { kind: "blocks", direction: "in", other: { id: blocker.id, title: "Migrate the database", status: "backlog" } },
    ]);

    m.transitions.transition(blocker.id, "done", "operator", { human: true });
    await h.walk.tick();
    expect(status(waiting.id)).toBe("backlog");
  });

  it("releases a PR gate once the PR has merged, and not while it is open", async () => {
    const url = "https://github.com/acme/widgets/pull/18";
    const gated = blocked("Ship the follow-up", { body: `after ${url} merges` });
    let state = "OPEN";
    const h = open({ links: new Proxy({}, { get: () => state }) as Record<string, string> });

    await h.walk.tick();
    expect(status(gated.id)).toBe("blocked");
    state = "MERGED";
    await h.walk.tick();
    expect(status(gated.id)).toBe("backlog");
    expect((section(h.turns[1].prompt, "## The board") as BoardTodo[])[0].links).toEqual([{ url, kind: "pull", state: "MERGED" }]);
  });

  it("flags a stuck Todo with exactly one comment across two ticks", async () => {
    const stuck = blocked("A stuck decision");
    const h = open();
    const first = await h.walk.tick();
    const second = await h.walk.tick();

    expect(walkComments(stuck.id)).toHaveLength(1);
    expect(walkComments(stuck.id)[0].body).toMatch(/^Board walk: this looks stuck\./);
    expect(first.entries).toContainEqual(expect.objectContaining({ kind: "stuck", workItemId: stuck.id, outcome: "flagged with a comment" }));
    expect(second.entries).toContainEqual(expect.objectContaining({ kind: "stuck", workItemId: stuck.id, outcome: "already flagged; not raised again" }));
    // The second prompt tells the model it already raised this one.
    expect((section(h.turns[1].prompt, "## The board") as BoardTodo[])[0].flaggedStuck).toBe(true);
  });

  it("raises a stuck Todo again once it has moved and got stuck anew", async () => {
    const stuck = blocked("A stuck decision");
    const h = open();
    await h.walk.tick();
    m.transitions.transition(stuck.id, "backlog", "operator", { human: true });
    m.transitions.transition(stuck.id, "blocked", "operator", { human: true });
    await h.walk.tick();
    expect(walkComments(stuck.id)).toHaveLength(2);
  });

  it("parks a plain date gate, and the park expiry re-queues it when the date passes", async () => {
    const item = todo("Please park until the launch", { body: "not before 2026-10-10" });
    const h = open();
    const tick = await h.walk.tick();

    expect(status(item.id)).toBe("blocked");
    expect(m.stopCause.readStopCause(m.db, item.id, NOW)?.parkedUntil).toBe("2026-10-10T00:00:00.000Z");
    expect(tick.entries).toContainEqual(expect.objectContaining({ kind: "park", workItemId: item.id, outcome: "parked until 2026-10-10T00:00:00.000Z" }));
    expect(h.dispatched).not.toContain(item.id);

    expect(m.parkExpiry.releaseExpiredParks(new Date("2026-10-10T00:01:00Z"))).toBe(1);
    expect(status(item.id)).toBe("backlog");
  });
});

// ── Dispatch ─────────────────────────────────────────────────────────────────

describe("board walk dispatch", () => {
  it("starts a ready Todo through the Dispatcher when there is spare capacity, and says so on the Todo", async () => {
    const item = todo("Write the release notes", { priority: 3 });
    const h = open();
    const tick = await h.walk.tick();

    expect(h.dispatched).toEqual([item.id]);
    expect(tick.entries).toContainEqual({ kind: "dispatch", workItemId: item.id, reason: "daytime, the five-hour window lapses in 40 min at 15%", outcome: "started the Todo Dispatcher", sessionId: `dispatch-${item.id}` });
    expect(walkComments(item.id)[0].body).toMatch(/^Board walk: started the Todo Dispatcher \(session dispatch-/);
    expect(tick.summary).toMatch(/^1 started\. Dispatch: /);
    expect(tick.modelSummary).toBeTruthy();
  });

  it.each([
    ["the operator is live", { sessions: [{ id: "chat", source: "web", parentSessionId: null, employee: null, lastActivity: new Date(NOW - 5 * 60_000).toISOString() } as unknown as Session] }],
    ["the ceiling is reached", { fiveHourUsed: 70 }],
    ["a session holds capacity", { holding: 1 }],
  ])("starts nothing when %s, and logs why", async (_label, opts) => {
    todo("Write the release notes");
    const h = open(opts);
    const tick = await h.walk.tick();
    expect(h.dispatched).toEqual([]);
    const hold = tick.entries.find((entry) => entry.kind === "hold");
    expect(hold?.outcome).toBe("nothing started");
    expect(hold?.reason).toBeTruthy();
  });

  it("refuses to start a Todo that opted out or belongs to the operator, whatever the model asks", async () => {
    const labelled = todo("Labelled out");
    if (!m.labels.listLabels().some((label) => label.name === "no-auto-start")) m.labels.createLabel({ name: "no-auto-start" });
    m.labels.addWorkItemLabels(labelled.id, ["no-auto-start"], "operator");
    const mine = todo("Mine", { assignee: "@operator" });
    const h = open({ startAll: true });
    const tick = await h.walk.tick();
    expect(h.dispatched).toEqual([]);
    expect(tick.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "refused", workItemId: labelled.id, outcome: "it refuses automatic starts (label no-auto-start)" }),
      expect.objectContaining({ kind: "refused", workItemId: mine.id, outcome: "it refuses automatic starts (assigned to the operator)" }),
    ]));
  });

  it("puts the capacity snapshot in the prompt: readings, reset times, predictions and more than one engine", async () => {
    todo("Anything");
    const h = open();
    await h.walk.tick();
    const snapshot = section(h.turns[0].prompt, "## Capacity snapshot") as CapacitySnapshot;
    expect(snapshot.engines.map((engine) => engine.name)).toEqual(["claude", "codex"]);
    const fiveHour = snapshot.engines[0].windows.find((window) => window.name === "5h");
    expect(fiveHour).toMatchObject({ usedPercent: 15, minutesToReset: 40, windowMinutes: 300 });
    expect(snapshot.engines[0].startedThisWindow).toMatchObject({ total: 0 });
    expect(snapshot.localTime).toBeTruthy();
  });
});

// ── Switches and logging ─────────────────────────────────────────────────────

describe("board walk switches and the tick log", () => {
  it("has no switch of its own: the cron job is what runs it, and the status says which", async () => {
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    const job: CronJob = { id: "board-walk", name: "Board walk", enabled: false, schedule: "30 * * * *", timezone: "Asia/Tokyo", prompt: "", action: "board-walk" };
    const h = open({ job });
    // A disabled job is not fired by the scheduler; a run-now still ticks.
    expect(h.walk.status()).toMatchObject({ scheduled: false, job: { id: "board-walk", enabled: false, schedule: "30 * * * *", timezone: "Asia/Tokyo" } });
    const tick = await h.walk.tick("manual");
    expect(tick.outcome).toBe("ok");
    expect(status(past.id)).toBe("backlog");
    // "Local time" is read in the job's zone.
    expect(h.turns[0].prompt).toContain("in Asia/Tokyo.");
    expect(open({ job: { ...job, enabled: true } }).walk.status()).toMatchObject({ scheduled: true });
    expect(open().walk.status()).toMatchObject({ scheduled: false, job: null });
  });

  it("a retired enabled: false in the file switches nothing off, and the status names the stale key", async () => {
    fs.writeFileSync(RULES, TEMPLATE.replace("employee: assistant", "enabled: false\nemployee: assistant"));
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    const h = open();
    expect((await h.walk.tick()).outcome).toBe("ok");
    expect(status(past.id)).toBe("backlog");
    expect(h.walk.status().retiredKeys).toEqual(["enabled"]);
  });

  it("a scheduled fire landing on a running tick is skipped with its own record, never stacked", async () => {
    todo("Ready work");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = open({ reply: async (turn) => { await gate; return { sessionId: "slow", reply: fakeModel(turn.prompt) }; } });
    const first = h.walk.tick("schedule");
    const second = await h.walk.tick("schedule");
    expect(second).toMatchObject({ outcome: "busy", trigger: "schedule" });
    const joined = h.walk.tick("manual");
    release();
    expect((await first).outcome).toBe("ok");
    expect(await joined).toBe(await first);
    expect(h.turns).toHaveLength(1);
  });

  it("turning off just dispatch keeps readiness running and starts nothing", async () => {
    fs.writeFileSync(RULES, TEMPLATE.replace(/^(\s+dispatch:) true$/m, "$1 false"));
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    const ready = todo("Ready work");
    const h = open();
    const tick = await h.walk.tick();
    expect(h.turns[0].prompt).toContain("These actions are switched OFF and the gateway will refuse them: dispatch.");
    expect(status(past.id)).toBe("backlog");
    expect(h.dispatched).toEqual([]);
    expect(tick.entries).toContainEqual(expect.objectContaining({ kind: "refused", workItemId: ready.id, outcome: "dispatch is switched off" }));
  });

  it("logs every tick with its reasons, including nothing to do, and spends no turn on an empty board", async () => {
    const h = open();
    const empty = await h.walk.tick();
    expect(empty).toMatchObject({ outcome: "ok", summary: "nothing to do: the board has no open Todos" });
    expect(h.turns).toEqual([]);

    todo("Ready work");
    const busy = open({ fiveHourUsed: 90 });
    const held = await busy.walk.tick();
    expect(held.summary).toMatch(/^nothing to do\. /);
    expect(held.summary).toMatch(/Dispatch: the five-hour window is at 90%/);

    const log = m.boardStore.readTicks(10);
    expect(log.map((record) => record.summary)).toEqual([held.summary, empty.summary]);
    expect(log[0].entries.every((entry) => entry.reason)).toBe(true);
    expect(log[0].sessionId).toBe("walk-1");
  });

  it("an unreadable answer is a failed tick that changes nothing", async () => {
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    const h = open({ reply: () => ({ sessionId: "s", reply: "I released it for you." }) });
    const tick = await h.walk.tick();
    expect(tick).toMatchObject({ outcome: "failed", summary: "the answer could not be used: the reply carried no JSON object" });
    expect(status(past.id)).toBe("blocked");
  });

  it("a failed model turn is logged and changes nothing", async () => {
    todo("Ready work");
    const h = open({ reply: () => ({ sessionId: "s", error: "rate limited" }) });
    const tick = await h.walk.tick();
    expect(tick).toMatchObject({ outcome: "failed", summary: "the model turn failed: rate limited", sessionId: "s" });
    expect(h.dispatched).toEqual([]);
  });

  it("a broken rules file holds the walk and says why", async () => {
    fs.writeFileSync(RULES, "---\nactions:\n  dispatch: sometimes\n---\n");
    todo("Ready work");
    const h = open();
    const tick = await h.walk.tick();
    expect(tick).toMatchObject({ outcome: "invalid-rules", summary: "actions.dispatch must be true or false" });
    expect(h.turns).toEqual([]);
  });

  it("refuses a decision about a Todo that is not open or does not exist", async () => {
    const closed = todo("Closed");
    m.transitions.transition(closed.id, "done", "operator", { human: true });
    todo("Open");
    const reply = JSON.stringify({ todos: [
      { id: closed.id, verdict: "ready", action: "release", reason: "x" },
      { id: "ZZZ-999", verdict: "ready", action: "release", reason: "y" },
      { id: "ZZZ-1", verdict: "maybe", action: "release", reason: "z" },
    ], dispatch: { start: [], reason: "nothing ready" } });
    const h = open({ reply: () => ({ reply }) });
    const tick = await h.walk.tick();
    expect(tick.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "refused", workItemId: closed.id, outcome: "the walk only touches open Todos; this one is done" }),
      expect.objectContaining({ kind: "refused", workItemId: "ZZZ-999", outcome: "no such Todo" }),
      expect.objectContaining({ kind: "refused", outcome: "unreadable decision, ignored" }),
    ]));
  });
});

describe("board walk guards from review", () => {
  it("never releases or parks a Todo that waits on the operator, but may flag it", async () => {
    const mine = blocked("Renew the cert, my call", { body: "not before 2026-09-30", assignee: "@operator" });
    const named = todo("Pick the vendor, park me", { body: "not before 2026-10-10" });
    m.transitions.transition(named.id, "blocked", "operator", { human: true, stopCause: { unblockHint: { what: "choose a vendor", who: "the operator" } } });
    const reply = JSON.stringify({ todos: [
      { id: mine.id, verdict: "ready", action: "release", reason: "date passed" },
      { id: named.id, verdict: "gated", action: "park", until: "2026-10-10T00:00:00Z", reason: "date" },
      { id: mine.id, verdict: "stuck", action: "flag", reason: "nobody decided" },
    ], dispatch: { start: [], reason: "nothing" } });
    const h = open({ reply: () => ({ reply }) });
    const tick = await h.walk.tick();
    expect(status(mine.id)).toBe("blocked");
    expect(m.stopCause.readStopCause(m.db, named.id, NOW)).toEqual({ unblockHint: { what: "choose a vendor", who: "the operator" } });
    expect(tick.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "refused", workItemId: mine.id, outcome: "only the operator releases it: it is assigned to the operator" }),
      expect.objectContaining({ kind: "refused", workItemId: named.id, outcome: "only the operator parks it: it waits on the operator (choose a vendor)" }),
      expect.objectContaining({ kind: "stuck", workItemId: mine.id, outcome: "flagged with a comment" }),
    ]));
  });

  it("re-parks a clock-wait keeping who it waits on, and never parks a Todo stopped for a person", async () => {
    const clock = todo("Ship after the freeze, park me", { body: "not before 2026-10-10" });
    m.transitions.transition(clock.id, "blocked", "operator", { human: true, blockKind: "transient", stopCause: { parkedUntil: "2026-10-05T00:00:00Z", unblockHint: { what: "the release freeze ends", who: "the platform team" } } });
    const person = todo("Waiting on legal, park me", { body: "not before 2026-10-10" });
    m.transitions.transition(person.id, "blocked", "operator", { human: true, stopCause: { unblockHint: { what: "legal sign-off", who: "the legal team" } } });
    const h = open();
    const tick = await h.walk.tick();
    expect(m.stopCause.readStopCause(m.db, clock.id, NOW)).toEqual({
      parkedUntil: "2026-10-10T00:00:00.000Z",
      unblockHint: { what: "the release freeze ends", who: "the platform team" },
    });
    expect(m.stopCause.readStopCause(m.db, person.id, NOW)).toEqual({ unblockHint: { what: "legal sign-off", who: "the legal team" } });
    expect(tick.entries).toContainEqual(expect.objectContaining({ kind: "refused", workItemId: person.id, outcome: "it is stopped for a person (needs_input); a park would release it on the date" }));
  });

  it("gives up on a turn that does not finish, logs it, and frees the walk for the next tick", async () => {
    todo("Ready work");
    let calls = 0;
    const stopped: string[] = [];
    const h = open({ turnTimeoutMs: 50, stopped, reply: () => { calls++; return calls === 1 ? new Promise<WalkTurnResult>(() => {}) : { reply: JSON.stringify({ todos: [], dispatch: { start: [], reason: "fine" } }) }; } });
    const stalled = await h.walk.tick();
    expect(stalled).toMatchObject({ outcome: "failed", summary: "the model turn failed: the model turn did not finish within 0 s; it was stopped" });
    expect(h.dispatched).toEqual([]);
    expect(stopped).toEqual([h.turns[0].sessionKey]);
    expect((await h.walk.tick()).outcome).toBe("ok");
  });
});

describe("board walk review round 2", () => {
  it("gives the model the shipped default for a section the operator deleted", async () => {
    const withoutDispatch = TEMPLATE.replace(/## Dispatch[\s\S]*?(?=## Your own rules)/, "");
    fs.writeFileSync(RULES, withoutDispatch);
    todo("Anything");
    const h = open();
    await h.walk.tick();
    expect(h.turns[0].prompt).toContain("## Shipped defaults for the sections the operator's file leaves out");
    expect(h.turns[0].prompt).toContain("### Default: Dispatch");
    expect(h.turns[0].prompt).not.toContain("### Default: Release");
  });

  it("keeps the board inside its share of the prompt and counts what it left out", async () => {
    const { buildBoardDigest } = await import("../board.js");
    for (let i = 0; i < 5; i++) todo(`Long ${i}`, { body: "x".repeat(1500) });
    const digest = await buildBoardDigest({ resolveLink: async (url, kind) => ({ url, kind, state: "unknown" }), maxChars: 4000 });
    expect(digest.todos.length).toBeGreaterThan(0);
    expect(digest.todos.length).toBeLessThan(5);
    expect(digest.omitted).toBe(5 - digest.todos.length);
  });

  it("starts through the real Dispatcher path with the board's dispatched event and the walk's mark", async () => {
    const item = todo("Write the release notes", { priority: 3 });
    const events: string[] = [];
    const walk = m.walk.startBoardWalk({
      getConfig: () => config, context: {} as never, rulesFile: RULES, now: () => NOW, scheduleJob: () => undefined,
      runTurn: async (turn) => ({ reply: fakeModel(turn.prompt) }),
      resolveLink: async (url, kind) => ({ url, kind, state: "unknown" }),
      sessions: () => [], holdingCapacity: () => [], collectClaude: async () => claude(15),
      emitProjectionEvent: (id, action) => events.push(`${id}:${action}`),
      snapshot: { collect: async () => limits(15), usageHistory: () => [], statuslineMtime: () => undefined, startedSince: () => [], exhausted: () => false },
    });
    dispatcherStarts.length = 0;
    await walk.tick();
    expect(dispatcherStarts.map((start) => start.id)).toEqual([item.id]);
    const opts = dispatcherStarts[0].opts as { emitProjectionEvent: (id: string, action: string) => void; transportMeta: unknown; promptSuffix: string };
    expect(opts.transportMeta).toEqual({ startedBy: "board-walk" });
    expect(opts.promptSuffix).toMatch(/^The board walk started this Todo\. Its reason: /);
    opts.emitProjectionEvent(item.id, "dispatched");
    expect(events).toEqual([`${item.id}:dispatched`]);
  });
});

describe("a release is checked against the gates it cites", () => {
  const releaseReply = (id: string, gates?: unknown) => () => ({ reply: JSON.stringify({ todos: [{ id, verdict: "ready", action: "release", reason: "met", ...(gates ? { gates } : {}) }], dispatch: { start: [], reason: "nothing" } }) });

  it.each([
    ["no gate at all", undefined, "a release must cite the gates that are met"],
    ["a quote that names no date", [{ kind: "date", date: "2026-09-01", quote: "after https://github.com" }], "do not name 2026-09-01"],
    ["a past date the Todo never names", [{ kind: "date", date: "2026-09-01", quote: "not before 1 September" }], "the quoted words \"not before 1 September\" are not in this Todo"],
    ["a date with no quote", [{ kind: "date", date: "2026-09-01" }], "a release must cite the gates that are met"],
    ["a pull request the Todo does not link", [{ kind: "pr", url: "https://github.com/acme/widgets/pull/9" }], "https://github.com/acme/widgets/pull/9 is not linked from this Todo"],
    ["an open pull request", [{ kind: "pr", url: "https://github.com/acme/widgets/pull/18" }], "https://github.com/acme/widgets/pull/18 is OPEN"],
  ])("refuses a release citing %s", async (_label, gates, outcome) => {
    const item = blocked("Waiting", { body: "after https://github.com/acme/widgets/pull/18 merges" });
    const h = open({ reply: releaseReply(item.id, gates), links: { "https://github.com/acme/widgets/pull/18": "OPEN" } });
    const tick = await h.walk.tick();
    expect(status(item.id)).toBe("blocked");
    expect(tick.entries.find((entry) => entry.workItemId === item.id)).toMatchObject({ kind: "refused", workItemId: item.id, outcome: expect.stringContaining(outcome) });
  });

  it("QA repro: a person's decision cannot be released by citing any past date", async () => {
    const item = todo("Pick a vendor", { body: "Harry to choose between vendor A and vendor B.", assignee: "senior-developer" });
    m.transitions.transition(item.id, "blocked", "operator", { human: true, blockKind: "needs_input", stopCause: { unblockHint: { what: "pick a vendor", who: "Harry" } } });
    for (const gates of [
      [{ kind: "date", date: "2026-01-01" }],
      [{ kind: "date", date: "2026-01-01", quote: "Harry to choose" }],
      [{ kind: "date", date: "2026-01-01", quote: "1 January" }],
    ]) {
      const tick = await open({ reply: releaseReply(item.id, gates) }).walk.tick();
      expect(tick.entries.find((entry) => entry.workItemId === item.id)).toMatchObject({ kind: "refused", outcome: expect.stringMatching(/^gate not confirmed: /) });
    }
    expect(status(item.id)).toBe("blocked");
  });

  it("refuses a date the Todo names that is still ahead", async () => {
    const item = blocked("Invoice", { body: "Not before 1 November." });
    const tick = await open({ reply: releaseReply(item.id, [{ kind: "date", date: "2026-11-01", quote: "Not before 1 November" }]) }).walk.tick();
    expect(status(item.id)).toBe("blocked");
    expect(tick.entries[0].outcome).toBe("gate not confirmed: the date 2026-11-01 has not passed");
  });

  it("refuses a quote that is the Todo's own words but names another day", async () => {
    const item = blocked("Renew", { body: "Not before 30 September; reminder sent 1 September." });
    const tick = await open({ reply: releaseReply(item.id, [{ kind: "date", date: "2026-09-30", quote: "reminder sent 1 September" }]) }).walk.tick();
    expect(status(item.id)).toBe("blocked");
    expect(tick.entries[0].outcome).toBe('gate not confirmed: the quoted words "reminder sent 1 September" do not name 2026-09-30');
  });

  it("refuses a Todo whose only gate is a person's reply, and says so in the tick log", async () => {
    const item = blocked("Ship the pricing page", { body: "Once Harry replies with the final copy." });
    const tick = await open({ reply: releaseReply(item.id) }).walk.tick();
    expect(status(item.id)).toBe("blocked");
    expect(tick.entries[0]).toEqual({
      kind: "refused", workItemId: item.id, reason: "met",
      outcome: "gate not confirmed: a release must cite the gates that are met (a date, a blocker or a pull request), so the gateway can check them",
    });
    expect(m.boardStore.readTicks(1)[0].entries[0].outcome).toMatch(/^gate not confirmed/);
  });

  it("does not take the walk's own earlier comment as the Todo's words", async () => {
    const item = blocked("Waiting on legal");
    m.comments.addComment({ workItemId: item.id, body: "Board walk: this looks stuck. not before 2026-09-01", author: "board-walk", authorKind: "system" });
    const tick = await open({ reply: releaseReply(item.id, [{ kind: "date", date: "2026-09-01", quote: "not before 2026-09-01" }]) }).walk.tick();
    expect(status(item.id)).toBe("blocked");
    expect(tick.entries[0].outcome).toMatch(/are not in this Todo/);
  });

  it("refuses a blocker the Todo does not name, and one that is not done", async () => {
    const stranger = todo("Unrelated");
    m.transitions.transition(stranger.id, "done", "operator", { human: true });
    const open1 = todo("Still going");
    const item = blocked("Waiting", { body: `after ${open1.id}` });
    const first = await open({ reply: releaseReply(item.id, [{ kind: "blocker", id: stranger.id }]) }).walk.tick();
    expect(first.entries[0].outcome).toBe(`gate not confirmed: ${stranger.id} is not a blocker this Todo names`);
    const second = await open({ reply: releaseReply(item.id, [{ kind: "blocker", id: open1.id }]) }).walk.tick();
    expect(second.entries[0].outcome).toBe(`gate not confirmed: blocker ${open1.id} is backlog, not done`);
    expect(status(item.id)).toBe("blocked");
  });

  it("never releases an approval question carried over from the retired approvals, even with a met gate", async () => {
    // The exact shape the retired-approvals migration leaves: needs_input,
    // the original (non-operator) assignee kept, no unblock hint.
    const item = todo("Merge the fix or request changes", { body: "not before 2026-09-30", assignee: "senior-developer" });
    m.transitions.transition(item.id, "blocked", "migration", { blockKind: "needs_input", detail: { reason: "retired-approval", declared: true, blockKind: "needs_input" } });
    expect(m.stopCause.readStopCause(m.db, item.id, NOW)).toBeUndefined();
    const tick = await open({ reply: releaseReply(item.id, [{ kind: "date", date: "2026-09-30", quote: "not before 2026-09-30" }]) }).walk.tick();
    expect(status(item.id)).toBe("blocked");
    expect(m.store.getWorkItem(item.id)!.assignee).toBe("senior-developer");
    expect(tick.entries[0].outcome).toBe("only the operator releases it: it holds an unanswered approval question");
  });
});

describe("the board walk as a cron job", () => {
  const job: CronJob = { id: "board-walk", name: "Board walk", enabled: true, schedule: "0 * * * *", prompt: "", action: "board-walk" };
  const runs = async () => {
    const { CRON_RUNS } = await import("../../shared/paths.js");
    const file = path.join(CRON_RUNS, "board-walk.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  };

  it("a fire of the job runs one tick and records it as a run, with no engine session or Todo of its own", async () => {
    const { runCronJob } = await import("../../cron/runner.js");
    const { setCronActionHandler } = await import("../../cron/actions.js");
    const { boardWalkCronHandler } = await import("../job.js");
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    const h = open({ job });
    setCronActionHandler("board-walk", boardWalkCronHandler(h.walk));
    const route = vi.fn();
    const todos = () => m.db.prepare("SELECT COUNT(*) FROM work_items").pluck().get() as number;
    const before = todos();
    try {
      await runCronJob(job, { route } as never, config, new Map(), { trigger: "schedule", fireIso: "2026-10-02T12:00:00.000Z" });
      await runCronJob(job, { route } as never, config, new Map());
    } finally {
      setCronActionHandler("board-walk", null);
    }
    expect(h.turns).toHaveLength(2);
    expect(status(past.id)).toBe("backlog");
    expect(route).not.toHaveBeenCalled();
    expect(todos()).toBe(before);
    expect(m.boardStore.readTicks(10).map((tick) => tick.trigger)).toEqual(["manual", "schedule"]);
    const logged = (await runs()).slice(-2);
    expect(logged).toEqual([
      expect.objectContaining({ status: "success", trigger: "schedule", sessionId: "walk-1", error: null }),
      expect.objectContaining({ status: "success", trigger: "manual", sessionId: "walk-2", error: null }),
    ]);
  });

  it("a fire with no walk to run is a failed run, not a silent one", async () => {
    const { runCronJob } = await import("../../cron/runner.js");
    await runCronJob(job, {} as never, config, new Map(), { trigger: "schedule" });
    expect((await runs()).at(-1)).toMatchObject({ status: "error", error: "the board-walk action is not available in this gateway" });
  });
});

