import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineLimitEngineSnapshot, EngineLimitsResponse, JinnConfig, Session } from "../../shared/types.js";
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

const walks: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const walk of walks.splice(0)) walk.stop();
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
    if (date) { gateMet = Date.parse(date) <= now; reason = `not before ${date}`; }
    if (blocker) { gateMet = blocker.other.status === "done"; reason = `blocked by ${blocker.other.id} (${blocker.other.status})`; }
    if (pr) { gateMet = pr.state === "MERGED"; reason = `${pr.url} is ${pr.state}`; }
    if (/stuck/.test(item.title)) {
      decisions.push({ id: item.id, verdict: "stuck", action: "flag", reason: "no change for days; the operator should decide" });
    } else if (gateMet === undefined) {
      continue;
    } else if (item.status === "blocked" && gateMet) {
      decisions.push({ id: item.id, verdict: "ready", action: "release", reason: `gate met: ${reason}` });
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
  reply?: (turn: WalkTurn) => WalkTurnResult;
  fiveHourUsed?: number;
  sessions?: Session[];
  holding?: number;
  links?: Record<string, string>;
  startAll?: boolean;
} = {}): Harness {
  const turns: WalkTurn[] = [];
  const dispatched: string[] = [];
  const walk = m.walk.startBoardWalk({
    getConfig: () => config,
    context: {} as never,
    rulesFile: RULES,
    now: () => NOW,
    pollMs: 3_600_000,
    runTurn: async (turn) => {
      turns.push(turn);
      return opts.reply ? opts.reply(turn) : { sessionId: `walk-${turns.length}`, reply: fakeModel(turn.prompt, { startAll: opts.startAll }) };
    },
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
  walks.push(walk);
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
    expect(tick.summary).toMatch(/^1 started\./);
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
  it("enabled: false stops everything: no model turn, no move, a logged reason", async () => {
    fs.writeFileSync(RULES, TEMPLATE.replace("enabled: true", "enabled: false"));
    const past = blocked("Renew the cert", { body: "not before 2026-09-30" });
    todo("Ready work");
    const h = open();
    const tick = await h.walk.tick();
    expect(tick.outcome).toBe("disabled");
    expect(h.turns).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(status(past.id)).toBe("blocked");
    expect(h.walk.status()).toMatchObject({ scheduled: false, settings: { enabled: false } });
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
