import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Employee, EngineLimitEngineSnapshot, JinnConfig, Session } from "../../shared/types.js";
import type { EngineLimitAccountSnapshot } from "../../shared/engine-limits-accounts.js";

/**
 * The board walk judges each Claude account on its own (FR-075): candidates
 * carry their account, a start on an account recorded at its limit is refused
 * in code, the Dispatcher is told which accounts are spent, and the snapshot
 * carries each account's readings, holdings and starts.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-walk-accounts-"));
process.env.JINN_HOME = home;

const m = {} as {
  accounts: typeof import("../accounts.js");
  apply: typeof import("../apply.js");
  walk: typeof import("../walk.js");
  snap: typeof import("../snapshot-accounts.js");
  store: typeof import("../../work-items/store.js");
  limits: typeof import("../../shared/engine-limits-accounts.js");
  profile: typeof import("../../shared/claude-profile.js");
};

const FRIEND = "/Users/operator/.claude-friend";
let friendKey: string;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } } } as unknown as JinnConfig;
const roster: Record<string, Employee> = {
  op: { name: "op", engine: "claude" } as Employee,
  "side-dev": { name: "side-dev", engine: "claude", claudeConfigDir: FRIEND } as Employee,
  coder: { name: "coder", engine: "codex" } as Employee,
};
const spent = (at = NOW) => ({ state: "exhausted" as const, until: new Date(at + 3600_000).toISOString(), recheckAt: new Date(at + 3600_000).toISOString() });

beforeAll(async () => {
  m.accounts = await import("../accounts.js");
  m.apply = await import("../apply.js");
  m.walk = await import("../walk.js");
  m.snap = await import("../snapshot-accounts.js");
  m.store = await import("../../work-items/store.js");
  m.limits = await import("../../shared/engine-limits-accounts.js");
  m.profile = await import("../../shared/claude-profile.js");
  friendKey = `claude:${m.profile.claudeProfileFromDir(FRIEND).key}`;
  m.limits.registerAccountRoster(() => Object.values(roster));
});

afterAll(() => m.limits.registerAccountRoster(() => []));

function view(health: Record<string, ReturnType<typeof spent>> = {}) {
  return m.accounts.walkAccounts({ config, now: NOW, health, employee: (name) => roster[name] });
}

describe("which account a candidate runs on", () => {
  it("is its assignee's, or unrouted", () => {
    const a = view();
    expect(a.multi).toBe(true);
    expect(a.of({ id: "XYZ-1", assignee: "side-dev" })).toBe(friendKey);
    expect(a.of({ id: "XYZ-2", assignee: "op" })).toBe("claude");
    expect(a.of({ id: "XYZ-3", assignee: "coder" })).toBe("codex");
    expect(a.of({ id: "XYZ-4", assignee: null })).toBe(m.accounts.UNROUTED);
    expect(a.label(friendKey)).toBe(".claude-friend");
  });

  it("judges an unrouted Todo against the default account", () => {
    expect(view({ claude: spent() }).exhausted(m.accounts.UNROUTED)).toBe(true);
    expect(view({ [friendKey]: spent() }).exhausted(m.accounts.UNROUTED)).toBe(false);
  });
});

describe("the start gate, in code", () => {
  const settings = { actions: { dispatch: true, comment: false, release: true, park: true, flagStuck: true } } as never;

  function start(assignee: string | null, health: Record<string, ReturnType<typeof spent>>) {
    const item = m.store.createWorkItem({ title: `t-${assignee}`, status: "backlog", source: "human", ...(assignee ? { assignee } : {}) });
    const dispatch = vi.fn(() => ({ ok: true, status: 201, body: { workItemId: item.id, sessionId: "s-1", status: "running", reused: false } }) as never);
    const entry = m.apply.startTodo({ settings, state: { stuckFlags: {} }, dispatch, now: () => NOW, resolveLink: vi.fn(), accounts: view(health) }, { id: item.id, reason: "lapsing" } as never);
    return { entry, dispatch };
  }

  it("refuses a start on an account recorded at its limit, and leaves other accounts' work alone", () => {
    const refused = start("side-dev", { [friendKey]: spent() });
    expect(refused.entry).toMatchObject({ kind: "refused", outcome: "the account it would run on (.claude-friend) is recorded at its limit" });
    expect(refused.dispatch).not.toHaveBeenCalled();

    const started = start("op", { [friendKey]: spent() });
    expect(started.entry.outcome).toBe("started the Todo Dispatcher");
  });

  it("refuses an unrouted start while the default account is spent", () => {
    expect(start(null, { claude: spent() }).entry.kind).toBe("refused");
    expect(start("side-dev", { claude: spent() }).entry.outcome).toBe("started the Todo Dispatcher");
  });
});

describe("the Dispatcher's advice", () => {
  const decision = { id: "X-1", reason: "the friend's window lapses in 30 minutes" } as never;

  it("is unchanged with nothing spent, or one account", () => {
    expect(m.walk.dispatcherSuffix(decision)).toBe("The board walk started this Todo. Its reason: the friend's window lapses in 30 minutes");
  });

  it("names the spent accounts", () => {
    expect(m.walk.dispatcherSuffix(decision, ["claude"])).toBe(
      "The board walk started this Todo. Its reason: the friend's window lapses in 30 minutes These Claude accounts are recorded at their limit: claude. "
      + "Route the Todo to an employee on another account if one fits; on one of these it waits for that account's reset.",
    );
  });
});

describe("the snapshot per account", () => {
  const reading = (account: string, label: string, used: number, extra: Partial<EngineLimitAccountSnapshot> = {}): EngineLimitAccountSnapshot => ({
    name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [],
    windows: [{ name: "5h", usedPercent: used, windowDurationMins: 300, resetsAt: Math.floor((NOW + 40 * 60_000) / 1000) }],
    account, label, location: { kind: "local" }, employees: [], ...extra,
  });
  const session = (id: string, extra: Partial<Session>): Session => ({
    id, engine: "claude", status: "running", source: "web", createdAt: new Date(NOW - 10 * 60_000).toISOString(), lastActivity: new Date(NOW).toISOString(), ...extra,
  }) as Session;

  it("is absent with one account", () => {
    expect(m.snap.snapshotAccounts([reading("claude", "claude", 10)], { now: NOW, holding: [], todoAccount: () => "claude" })).toBeUndefined();
  });

  it("carries each account's windows, holdings, starts and usage delta", () => {
    const friendTodo = m.store.createWorkItem({ title: "friend work", status: "backlog", source: "human", assignee: "side-dev" });
    const walkStart = session("dispatcher-1", { employee: "todo-dispatcher", workItemId: friendTodo.id, transportMeta: { startedBy: "board-walk" } as never });
    const opChat = session("op-chat", { employee: "op" });
    const friendChat = session("friend-chat", { employee: "side-dev" });
    const sessionAccount = (s: Session) => (s.employee === "side-dev" ? friendKey : "claude");
    const accounts = m.snap.snapshotAccounts(
      [reading("claude", "claude", 80), reading(friendKey, ".claude-friend", 20, { noReading: undefined, exhausted: undefined })],
      {
        now: NOW, holding: [opChat, friendChat], sessionAccount,
        todoAccount: (item) => view().of(item),
        createdSince: () => [walkStart, opChat, friendChat],
        history: () => [],
        prior: { [friendKey]: { resetsAt: Math.floor((NOW + 40 * 60_000) / 1000), usedPercent: 15, atMs: NOW - 3600_000 } },
      },
    )!;
    const [operator, friend] = accounts;
    expect(operator).toMatchObject({ account: "claude", exhausted: false, holdingCapacityNow: 1, startedThisWindow: { total: 1, chat: 1 } });
    expect(friend).toMatchObject({
      account: friendKey, label: ".claude-friend", holdingCapacityNow: 1,
      // The walk's start runs as the Dispatcher, but it counts on the account its Todo runs on.
      startedThisWindow: { total: 2, "board-walk-dispatch": 1, chat: 1 },
      usageSincePreviousTick: { previousUsedPercent: 15, usedPercentNow: 20, risePoints: 5 },
    });
    expect(friend!.windows[0]).toMatchObject({ name: "5h", usedPercent: 20, minutesToReset: 40 });
  });

  it("marks an account with no live reading for the one probing start", () => {
    const [, friend] = m.snap.snapshotAccounts(
      [reading("claude", "claude", 10), { ...reading(friendKey, ".claude-friend", 0), status: "static", windows: [], noReading: true }],
      { now: NOW, holding: [], todoAccount: () => "claude", createdSince: () => [], history: () => [] },
    )!;
    expect(friend).toMatchObject({ noReading: true, exhausted: false, holdingCapacityNow: 0, windows: [] });
  });
});

describe("the walk's runner and its prior readings", () => {
  it("keeps each other account's five-hour reading for the next tick", async () => {
    const state: { stuckFlags: Record<string, string>; priorFiveHourByAccount?: Record<string, unknown> } = { stuckFlags: {} };
    const def = { name: "claude", windows: [] } as unknown as EngineLimitEngineSnapshot;
    await m.snap.recordAccountPriors(state as never, config, def, NOW, async () => [
      { ...def, account: "claude" } as EngineLimitAccountSnapshot,
      { ...def, account: friendKey, windows: [{ name: "5h", usedPercent: 33, resetsAt: Math.floor(NOW / 1000) + 600 }] } as EngineLimitAccountSnapshot,
    ]);
    expect(state.priorFiveHourByAccount).toEqual({ [friendKey]: { resetsAt: Math.floor(NOW / 1000) + 600, usedPercent: 33, atMs: NOW } });
    await m.snap.recordAccountPriors(state as never, config, def, NOW, async () => undefined);
    expect(state.priorFiveHourByAccount).toBeUndefined();
  });
});
