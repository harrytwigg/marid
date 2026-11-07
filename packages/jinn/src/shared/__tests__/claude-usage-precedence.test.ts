/**
 * Claude limits precedence: which source wins when the OAuth usage API and the
 * CLI's own statusline snapshot disagree.
 *
 * The usage API can answer 200 with a well-formed but entirely zeroed payload
 * for an account it holds no reading for. That is indistinguishable from a
 * genuinely idle account on its own — but not when the CLI, which reads its
 * percentages off the rate-limit headers of real requests, says otherwise.
 * These tests pin that tie-break so the Limits page never renders 0% over a
 * live session that is really at 12%.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig, EngineLimitsResponse } from "../types.js";

vi.mock("../claude-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-models.js")>()),
  readClaudeOAuthToken: async () => "test-oauth-token",
}));

let TEST_ROOT: string;
let CLAUDE_DIR: string;
let collectEngineLimits: (c: JinnConfig, o?: { engine?: string }) => Promise<EngineLimitsResponse>;
let invalidateModelRegistry: () => void;

const NODE = process.execPath;

function cfg(): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: NODE, model: "opus" } },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low"] }] },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

/** A usage-API payload whose every bucket reads zero, as seen in the wild. */
function zeroedUsagePayload(): Record<string, unknown> {
  return {
    five_hour: { utilization: 0, resets_at: "2026-09-04T12:20:00Z" },
    seven_day: { utilization: 0, resets_at: "2026-09-09T12:00:00Z" },
    limits: [
      { kind: "session", group: "session", percent: 0, resets_at: "2026-09-04T12:20:00Z", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 0, resets_at: "2026-09-09T12:00:00Z", scope: null },
    ],
  };
}

function stubUsageApi(payload: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => payload }) as unknown as Response);
}

function writeStatusline(fiveHour: number, sevenDay: number): void {
  fs.writeFileSync(
    path.join(CLAUDE_DIR, "session.json"),
    JSON.stringify({
      captured_at: new Date().toISOString(),
      rate_limits: {
        five_hour: { used_percentage: fiveHour, resets_at: 1788520800 },
        seven_day: { used_percentage: sevenDay, resets_at: 1789102800 },
      },
      context_window: { used_percentage: 9, remaining_percentage: 91 },
      cost: { total_cost_usd: 2.44 },
    }),
  );
}

/** A snapshot from an account whose plan has no five-hour limit: the CLI only
 *  ever sees a weekly rate-limit header for it. */
function writeWeeklyOnlyStatusline(sevenDay: number, fiveHour?: unknown, ageMs = 0): void {
  const file = path.join(CLAUDE_DIR, "session.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      captured_at: new Date(Date.now() - ageMs).toISOString(),
      rate_limits: { ...(fiveHour !== undefined ? { five_hour: fiveHour } : {}), seven_day: { used_percentage: sevenDay, resets_at: 1789102800 } },
    }),
  );
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

/** The usage API's view of the same account: a session bucket at zero beside a real weekly one. */
function sessionAtUsagePayload(sessionPercent: number, sessionResetsAt: string | null = "2026-11-06T16:59:59Z"): Record<string, unknown> {
  return {
    limits: [
      { kind: "session", group: "session", percent: sessionPercent, resets_at: sessionResetsAt, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 37, resets_at: "2026-11-12T09:00:00Z", scope: null },
    ],
  };
}

async function claudeSnapshot() {
  const res = await collectEngineLimits(cfg(), { engine: "claude" });
  return res.engines.claude;
}

beforeAll(async () => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-claude-precedence-"));
  CLAUDE_DIR = path.join(TEST_ROOT, "tmp", "engine-limits", "claude");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  process.env.JINN_HOME = TEST_ROOT;
  delete process.env.JINN_CLAUDE_USAGE_API;
  ({ collectEngineLimits } = await import("../engine-limits.js"));
  ({ invalidateModelRegistry } = await import("../models.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  vi.unstubAllGlobals();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, f));
  invalidateModelRegistry();
});

describe("collectEngineLimits — claude usage-API vs statusline precedence", () => {
  it("keeps the statusline percentages when the usage API reports all zeros", async () => {
    stubUsageApi(zeroedUsagePayload());
    writeStatusline(12, 3);

    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude-statusline");
    expect(claude.status).toBe("snapshot");
    expect(claude.windows?.map((w) => w.usedPercent)).toEqual([12, 3]);
  });

  it("still prefers the usage API when it reports real usage", async () => {
    stubUsageApi({
      limits: [
        { kind: "session", percent: 41, resets_at: "2026-09-04T12:20:00Z" },
        { kind: "weekly_scoped", percent: 7, resets_at: null, scope: { model: { display_name: "Fable" } } },
      ],
    });
    writeStatusline(12, 3);

    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude oauth usage api");
    expect(claude.status).toBe("live");
    expect(claude.windows?.map((w) => w.name)).toEqual(["5h", "7d Fable"]);
    // Context and cost have no usage-API equivalent — they still come off disk.
    expect(claude.context?.usedPercent).toBe(9);
    expect(claude.costUsd).toBe(2.44);
  });

  it("lets a zeroed usage API stand when the statusline agrees the account is idle", async () => {
    stubUsageApi(zeroedUsagePayload());
    writeStatusline(0, 0);

    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude oauth usage api");
    expect(claude.status).toBe("live");
  });

  it("lets a zeroed usage API stand when there is no snapshot to contradict it", async () => {
    stubUsageApi(zeroedUsagePayload());

    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude oauth usage api");
    expect(claude.status).toBe("live");
  });
});

describe("collectEngineLimits — claude five-hour window the plan does not have", () => {
  it("drops the usage API's zero five-hour bucket when the CLI only ever sees a weekly limit", async () => {
    stubUsageApi(sessionAtUsagePayload(0));
    writeWeeklyOnlyStatusline(37);

    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude oauth usage api");
    expect(claude.windows?.map((w) => w.name)).toEqual(["7d"]);
  });

  it("keeps a five-hour bucket the usage API reads above zero", async () => {
    stubUsageApi(sessionAtUsagePayload(100));
    writeWeeklyOnlyStatusline(37);

    const claude = await claudeSnapshot();
    expect(claude.windows?.[0]).toMatchObject({ name: "5h", usedPercent: 100, windowDurationMins: 300 });
  });

  it("keeps the 0% straight after a reset on an account that has a five-hour limit (its snapshot carries five_hour)", async () => {
    stubUsageApi(sessionAtUsagePayload(0, null));
    writeStatusline(0, 37);

    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude oauth usage api");
    expect(claude.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 0], ["7d", 37]]);
  });

  it("keeps the 5h window off however long the account has sat idle since its newest snapshot", async () => {
    stubUsageApi(sessionAtUsagePayload(0));
    writeWeeklyOnlyStatusline(37, undefined, 9 * 60 * 60_000);
    expect((await claudeSnapshot()).windows?.map((w) => w.name)).toEqual(["7d"]);

    writeWeeklyOnlyStatusline(37, undefined, 30 * 24 * 60 * 60_000);
    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude oauth usage api");
    expect(claude.windows?.map((w) => w.name)).toEqual(["7d"]);
  });

  it("brings the 5h window back once the newest snapshot carries five_hour", async () => {
    stubUsageApi(sessionAtUsagePayload(0));
    writeWeeklyOnlyStatusline(37);
    expect((await claudeSnapshot()).windows?.map((w) => w.name)).toEqual(["7d"]);

    writeStatusline(0, 37);
    expect((await claudeSnapshot()).windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 0], ["7d", 37]]);
  });

  it("keeps the usage API's 0% when the snapshot's five_hour entry is empty, null or has null fields", async () => {
    stubUsageApi(sessionAtUsagePayload(0));
    for (const fiveHour of [{}, null, { used_percentage: null, resets_at: null }]) {
      writeWeeklyOnlyStatusline(37, fiveHour);
      const claude = await claudeSnapshot();
      expect(claude.source).toBe("claude oauth usage api");
      expect(claude.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 0], ["7d", 37]]);
    }
  });

  it("keeps a five-hour reading above zero, however small, beside a weekly-only snapshot", async () => {
    stubUsageApi(sessionAtUsagePayload(0.4));
    writeWeeklyOnlyStatusline(37);

    const claude = await claudeSnapshot();
    expect(claude.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 0], ["7d", 37]]);
  });

  it("shows no five-hour window from a statusline snapshot without one", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false }) as unknown as Response);
    writeWeeklyOnlyStatusline(37);
    expect((await claudeSnapshot()).windows?.map((w) => w.name)).toEqual(["7d"]);

    // An empty bucket has no reading to draw.
    writeWeeklyOnlyStatusline(37, {});
    const claude = await claudeSnapshot();
    expect(claude.source).toBe("claude-statusline");
    expect(claude.windows?.map((w) => w.name)).toEqual(["7d"]);
  });
});
