import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Employee, JinnConfig } from "../../shared/types.js";

/**
 * The Auto-Dispatch usage card per account (FR-074): `?account=` picks whose
 * history, the body lists the accounts for the switcher, and a single account
 * answers exactly as before.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-usage-accounts-"));
process.env.JINN_HOME = home;
const { handleBoardWalkApi } = await import("../board-walk-api.js");
const { registerAccountRoster } = await import("../../shared/engine-limits-accounts.js");
const { recordClaudeUsageSample, usageHistoryPath } = await import("../../shared/claude-usage-history.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const FRIEND = "/Users/operator/.claude-friend";
const friendKey = `claude:${claudeProfileFromDir(FRIEND).key}`;
const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" } } } as unknown as JinnConfig;
const context = { getConfig: () => config } as never;

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { raw = chunk ? chunk.toString() : ""; },
    statusCode: 200,
  };
  const parsed = new URL(url, "http://localhost");
  const handled = await handleBoardWalkApi({} as never, res as never, { method: "GET", pathname: parsed.pathname, url: parsed }, context);
  expect(handled).toBe(true);
  return { status: status || res.statusCode, body: JSON.parse(raw) };
}

const live = (percent: number) => ({
  name: "claude", available: true, status: "live" as const, source: "t", refreshedAt: new Date().toISOString(), models: [],
  windows: [{ name: "5h", usedPercent: percent, resetsAt: Math.floor(Date.now() / 1000) + 3600 }],
});

beforeAll(() => {
  recordClaudeUsageSample(live(10));
  recordClaudeUsageSample(live(70), Date.now(), usageHistoryPath(friendKey));
});

afterAll(() => registerAccountRoster(() => []));

describe("one Claude account", () => {
  it("answers the samples alone, as before", async () => {
    registerAccountRoster(() => [{ name: "op", engine: "claude" } as Employee]);
    const { body } = await get("/api/auto-dispatch/usage?hours=24&account=claude:whatever");
    expect(Object.keys(body)).toEqual(["samples"]);
    expect((body.samples as Array<{ windows: Array<{ usedPercent: number }> }>)[0]!.windows[0]!.usedPercent).toBe(10);
  });
});

describe("two Claude accounts", () => {
  const roster = () => [{ name: "op", engine: "claude" }, { name: "side-dev", engine: "claude", claudeConfigDir: FRIEND }] as Employee[];

  it("defaults to the default account and lists both for the switcher", async () => {
    registerAccountRoster(roster);
    const { body } = await get("/api/auto-dispatch/usage?hours=24");
    expect(body.account).toBe("claude");
    expect(body.accounts).toEqual([{ account: "claude", label: "claude" }, { account: friendKey, label: ".claude-friend" }]);
  });

  it("reads the chosen account's own history", async () => {
    registerAccountRoster(roster);
    const { body } = await get(`/api/auto-dispatch/usage?hours=24&account=${encodeURIComponent(friendKey)}`);
    expect(body.account).toBe(friendKey);
    expect((body.samples as Array<{ windows: Array<{ usedPercent: number }> }>)[0]!.windows[0]!.usedPercent).toBe(70);
  });

  it("refuses an account it does not know", async () => {
    registerAccountRoster(roster);
    const { status } = await get("/api/auto-dispatch/usage?account=claude:00000000");
    expect(status).toBe(404);
  });
});
