/**
 * End to end for opencode accounts: a costed turn on an account goes through the
 * one accounting path, the collector meters it against that account's own
 * allowance, health holds `opencode/<provider>` (never the engine-wide key), the
 * limits response carries the account's card, and a new session for an employee
 * on that account starts on the next link. The stock provider and another
 * account are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Employee, HundredfoldConfig, EngineLimitsResponse } from "../types.js";
import type { OpencodeAccountLimitSnapshot } from "../engine-limits-opencode-accounts.js";

const NODE = process.execPath;
const B_FLASH = "opencode-go-b/flash";
const ENV = "OC_ACCOUNTS_E2E_KEY_B";

let home: string;
let collectEngineLimits: (c: HundredfoldConfig, o?: { engine?: string }) => Promise<EngineLimitsResponse>;

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: {
    default: "claude", claude: { bin: NODE, model: "opus" },
    opencode: {
      bin: NODE, model: B_FLASH,
      accounts: {
        "go-a": { provider: "opencode-go" },
        "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: ENV, usageLimits: { monthlyUsd: { "*": 60 } } },
        "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "OC_ACCOUNTS_E2E_KEY_C", usageLimits: { monthlyUsd: { "*": 60 } } },
      },
    },
  },
  connectors: {},
} as unknown as HundredfoldConfig;

async function seedTurn(id: string, model: string, cost: number): Promise<void> {
  const { initDb } = await import("../db.js");
  const { recordTurnAccounting } = await import("../../sessions/registry.js");
  initDb().prepare(
    "INSERT INTO sessions (id, engine, model, source, source_ref, status, created_at, last_activity) VALUES (?, 'opencode', ?, 'web', ?, 'idle', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')",
  ).run(id, model, `web:${id}`);
  recordTurnAccounting(id, { cost, numTurns: 1 });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-oc-accounts-e2e-"));
  process.env.HUNDREDFOLD_HOME = home;
  process.env.HUNDREDFOLD_CLAUDE_USAGE_API = "off";
  process.env[ENV] = "sentinel-key-value-b";
  ({ collectEngineLimits } = await import("../engine-limits.js"));
});

afterAll(() => {
  delete process.env.HUNDREDFOLD_HOME;
  delete process.env.HUNDREDFOLD_CLAUDE_USAGE_API;
  delete process.env[ENV];
  fs.rmSync(home, { recursive: true, force: true });
});

describe("opencode accounts: meter, health, limits response and reroute", () => {
  it("meters one account past its 5h window and routes new sessions around it alone", async () => {
    const { readEngineHealth, isEngineExhausted } = await import("../engine-health.js");
    const { rerouteAtCreation } = await import("../../sessions/fallback-reroute.js");
    const { availabilityRegistry } = await import("../../sessions/availability-registry.js");

    // $60 a month is $12 per 5h window: $13 on go-b's model spends it; go-c has spent $1.
    await seedTurn("acct-b", B_FLASH, 13);
    await seedTurn("acct-c", "opencode-go-c/flash", 1);
    const out = await collectEngineLimits(config, { engine: "opencode" });

    // The limits response: one entry per declared account, built-in included.
    const accounts = out.accounts?.opencode as OpencodeAccountLimitSnapshot[];
    expect(accounts.map((account) => account.account)).toEqual(["go-a", "go-b", "go-c"]);
    const [a, b, c] = accounts;
    expect(b).toMatchObject({ provider: "opencode-go-b", base: "opencode-go", keyEnv: ENV, keySet: true, employees: [] });
    expect(b!.buckets.map((bucket) => bucket.id)).toEqual([B_FLASH]);
    expect(b!.buckets[0]!.windows?.[0]).toMatchObject({ name: "5h" });
    expect(b!.buckets[0]!.windows![0]!.usedPercent).toBeGreaterThanOrEqual(100);
    expect(b!.exhausted?.until).toBeDefined();
    expect(b!.nextTryAt).toBeDefined();
    expect(c).toMatchObject({ keySet: false, problems: ['account "go-c" has no key: OC_ACCOUNTS_E2E_KEY_C is not set'] });
    expect(c!.exhausted).toBeUndefined();
    expect(a!.exhausted).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("sentinel-key-value-b");

    // Health: the provider's key, stamped with the model, and not the engine's.
    const health = readEngineHealth();
    expect(health["opencode/opencode-go-b"]).toMatchObject({ state: "exhausted", window: "5h", model: B_FLASH });
    expect(health.opencode).toBeUndefined();
    expect(health["opencode/opencode-go"]).toBeUndefined();
    expect(health["opencode/opencode-go-c"]).toBeUndefined();
    expect(isEngineExhausted(health, "opencode")).toBe(false);

    // A new session for an unpinned employee on go-b starts on the next link.
    const chain = [{ engine: "opencode", model: "opencode-go/flash" }, { engine: "opencode", model: "opencode-go-c/flash" }];
    const employee = { name: "worker", engine: "opencode", fallback: chain } as Employee;
    const registry = availabilityRegistry({}, (name) => name === "opencode");
    const start = (over: Partial<Parameters<typeof rerouteAtCreation>[0]> = {}) => rerouteAtCreation({
      config, employee, engine: "opencode", model: undefined, registry, health, scope: { scoped: false, remote: false }, ...over,
    });
    expect(start()).toMatchObject({ engine: "opencode", model: "opencode-go/flash", reroute: { from: "opencode", model: null } });

    // The stock provider and another account do not reroute: the same employee, run on them, stays put.
    const onStock = { ...config, engines: { ...config.engines, opencode: { ...config.engines.opencode, model: "opencode-go/flash" } } } as unknown as HundredfoldConfig;
    const onC = { ...config, engines: { ...config.engines, opencode: { ...config.engines.opencode, model: "opencode-go-c/flash" } } } as unknown as HundredfoldConfig;
    expect(start({ config: onStock })).toBeUndefined();
    expect(start({ config: onC })).toBeUndefined();
  });
});
