import { describe, expect, it } from "vitest";
import type { EngineLimitsResponse, JinnConfig, Session } from "../../shared/types.js";
import type { UsageSample } from "../../shared/claude-usage-history.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCapacitySnapshot, newestOperatorStatuslineMtime } from "../snapshot.js";
import { projectWindow } from "../projection.js";
import { countStarts, startedBy, toStartedSession } from "../started-sessions.js";
import { cachedResolver, findLinks, type LinkState } from "../pr-state.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const RESET = Math.floor((NOW + 60 * 60_000) / 1000);
const config = {} as JinnConfig;

function samples(points: Array<[minutesAgo: number, used: number]>, resetsAt = RESET): UsageSample[] {
  return points.map(([ago, used]) => ({ at: NOW - ago * 60_000, windows: [{ name: "5h", usedPercent: used, resetsAt }] }));
}

const session = (over: Partial<Session>): Session => ({
  id: "s", engine: "claude", source: "web", sourceRef: "web:x", sessionKey: "web:x", employee: null, parentSessionId: null,
  transportMeta: null, status: "idle", createdAt: new Date(NOW).toISOString(), lastActivity: new Date(NOW).toISOString(), model: null, title: null,
  ...over,
}) as Session;

describe("usage predictions", () => {
  it("projects the current window from its readings: rate, share at the reset, what lapses unused", () => {
    const projection = projectWindow(samples([[60, 10], [40, 14], [20, 18], [0, 22]]), "5h", NOW);
    expect(projection).toEqual({ kind: "projected", ratePerHour: 12, usedAtReset: 34, unusedAtReset: 66, basisMinutes: 60 });
  });

  it("names exhaustion when the line reaches 100 before the reset", () => {
    const projection = projectWindow(samples([[60, 40], [30, 70], [0, 95]]), "5h", NOW);
    expect(projection).toMatchObject({ kind: "projected", usedAtReset: 100, unusedAtReset: 0 });
    expect(projection.kind === "projected" && projection.exhaustsAt).toBeTruthy();
  });

  it("says why there is no prediction rather than guessing", () => {
    expect(projectWindow([], "5h", NOW)).toMatchObject({ kind: "none" });
    expect(projectWindow(samples([[10, 5], [0, 6]]), "5h", NOW)).toMatchObject({ kind: "none", reason: "fewer than three readings of this window so far" });
    expect(projectWindow(samples([[10, 5], [5, 6], [0, 7]]), "5h", NOW)).toMatchObject({ kind: "none", reason: "the readings span too short a time for a rate" });
    expect(projectWindow(samples([[60, 5], [30, 6], [0, 7]], Math.floor(NOW / 1000) - 60), "5h", NOW)).toMatchObject({ kind: "none" });
  });
});

describe("capacity snapshot", () => {
  const limits: EngineLimitsResponse = {
    generatedAt: "", default: "claude",
    engines: {
      claude: { name: "claude", available: true, status: "live", source: "t", refreshedAt: "", models: [], windows: [{ name: "5h", usedPercent: 22, windowDurationMins: 300, resetsAt: RESET }] },
      codex: { name: "codex", available: true, status: "live", source: "t", refreshedAt: "", models: [], windows: [{ name: "5h", usedPercent: 3, windowDurationMins: 300, resetsAt: RESET + 600 }] },
      grok: { name: "grok", available: true, status: "unsupported", source: "t", refreshedAt: "", models: [], unsupportedReason: "no quota endpoint" },
      pi: { name: "pi", available: false, status: "unavailable", source: "t", refreshedAt: "", models: [] },
    },
  };

  it("carries every engine's readings, predictions, start counts and the operator signals", async () => {
    const operatorChat = session({ id: "chat", lastActivity: new Date(NOW - 12 * 60_000).toISOString() });
    const snapshot = await buildCapacitySnapshot({
      config, timezone: "Europe/London", now: NOW,
      sessions: [operatorChat, session({ id: "cron", source: "cron", lastActivity: new Date(NOW).toISOString() })],
      holdingCapacity: () => [],
      prior: { resetsAt: RESET, usedPercent: 18, atMs: NOW - 60 * 60_000 },
      collect: async () => limits,
      usageHistory: () => samples([[60, 10], [40, 14], [20, 18], [0, 22]]),
      statuslineMtime: () => NOW - 3 * 60_000,
      startedSince: (_since, engine) => engine === "claude"
        ? [
          toStartedSession(session({ transportMeta: { startedBy: "board-walk" } })),
          toStartedSession(session({ employee: "todo-dispatcher" })),
          toStartedSession(session({ source: "cron", sessionKey: "board-walk:2026-10-02T11:00:00.000Z" })),
        ]
        : [],
      exhausted: () => false,
    });
    expect(snapshot).toMatchObject({ timezone: "Europe/London", localTime: "02/10/2026, 13:00", weekday: "Friday", sessionsHoldingCapacityNow: 0 });
    expect(snapshot.engines.map((engine) => engine.name)).toEqual(["claude", "codex"]);
    expect(snapshot.enginesWithoutReadings).toEqual(["grok (unsupported: no quota endpoint)"]);
    const claude = snapshot.engines[0];
    expect(claude.windows[0]).toMatchObject({ name: "5h", usedPercent: 22, minutesToReset: 60, prediction: { kind: "projected", usedAtReset: 34 } });
    expect(claude.startedThisWindow).toMatchObject({ total: 2, "board-walk-dispatch": 1, dispatch: 1, since: "2026-10-02T08:00:00.000Z" });
    expect(snapshot.engines[1].windows[0]).not.toHaveProperty("prediction");
    expect(snapshot.operator).toEqual({
      lastOperatorSessionActivity: { at: new Date(NOW - 12 * 60_000).toISOString(), minutesAgo: 12 },
      lastInteractiveCliTurn: { at: new Date(NOW - 3 * 60_000).toISOString(), minutesAgo: 3 },
      claudeUsageSincePreviousTick: { previousAt: new Date(NOW - 60 * 60_000).toISOString(), previousUsedPercent: 18, usedPercentNow: 22, risePoints: 4, jinnSessionActiveInBetween: true },
    });
  });

  it("leaves the usage delta out when the previous reading was of another window", async () => {
    const snapshot = await buildCapacitySnapshot({
      config, timezone: "UTC", now: NOW, sessions: [], holdingCapacity: () => [],
      prior: { resetsAt: RESET - 5 * 3600, usedPercent: 80, atMs: NOW - 60 * 60_000 },
      collect: async () => limits, usageHistory: () => [], statuslineMtime: () => undefined, startedSince: () => [], exhausted: () => true,
    });
    expect(snapshot.operator).toEqual({});
    expect(snapshot.engines[0].exhausted).toBe(true);
  });
});

describe("the interactive-CLI operator signal", () => {
  it("counts a statusline snapshot only when its session is one the operator drives", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-statusline-"));
    const write = (id: string, at: number) => {
      fs.writeFileSync(path.join(dir, `${id}.json`), "{}");
      fs.utimesSync(path.join(dir, `${id}.json`), at / 1000, at / 1000);
    };
    write("operator-chat", NOW - 40 * 60_000);
    write("walk-turn", NOW - 60_000);
    write("delegated", NOW - 30_000);
    write("unknown", NOW - 10_000);
    const sessions = [
      session({ id: "operator-chat" }),
      session({ id: "walk-turn", source: "cron", sessionKey: "board-walk:x" }),
      session({ id: "delegated", parentSessionId: "operator-chat" }),
    ];
    expect(newestOperatorStatuslineMtime(sessions, dir)).toBe(NOW - 40 * 60_000);
    expect(newestOperatorStatuslineMtime([], dir)).toBeUndefined();
  });
});

describe("what started a session", () => {
  it("labels each session from what the registry already knows", () => {
    expect(startedBy(session({ transportMeta: { startedBy: "board-walk" }, employee: "todo-dispatcher" }))).toBe("board-walk-dispatch");
    expect(startedBy(session({ sessionKey: "board-walk:2026-10-02T12:00:00.000Z", source: "cron" }))).toBe("board-walk");
    expect(startedBy(session({ employee: "todo-dispatcher" }))).toBe("dispatch");
    expect(startedBy(session({ employee: "todo-shaper" }))).toBe("capture");
    expect(startedBy(session({ source: "cron" }))).toBe("cron");
    expect(startedBy(session({ parentSessionId: "p" }))).toBe("delegated");
    expect(startedBy(session({}))).toBe("chat");
    expect(countStarts([toStartedSession(session({})), toStartedSession(session({ source: "cron" })), toStartedSession(session({}))]))
      .toEqual({ total: 3, chat: 2, cron: 1 });
  });
});

describe("linked pull requests and issues", () => {
  it("finds distinct GitHub PR and issue links in a Todo's text", () => {
    expect(findLinks([
      "after https://github.com/acme/widgets/pull/18 merges",
      "see https://github.com/acme/widgets/issues/7 and again https://github.com/acme/widgets/pull/18#issuecomment-1",
      null,
      "not a link: #18, nor https://example.com/acme/pull/1",
    ])).toEqual([
      { url: "https://github.com/acme/widgets/pull/18", kind: "pull" },
      { url: "https://github.com/acme/widgets/issues/7", kind: "issue" },
    ]);
  });

  it("caches answers but not unknowns", async () => {
    let calls = 0;
    let state = "unknown";
    const resolve = cachedResolver(async (url, kind): Promise<LinkState> => { calls++; return { url, kind, state }; }, 60_000, () => NOW);
    await resolve("u", "pull");
    await resolve("u", "pull");
    expect(calls).toBe(2);
    state = "OPEN";
    await resolve("u", "pull");
    await resolve("u", "pull");
    expect(calls).toBe(3);
  });
});
