/**
 * end to end: a costed opencode turn goes through the one accounting
 * path, the collector meters it against the configured allowance, and a spent
 * window reaches engine health as `exhausted` with the reopening the ledger
 * implies — the same write a spent Claude window makes, and the record the
 * session and Workflow dispatchers already route around.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig, EngineLimitsResponse } from "../types.js";

const NODE = process.execPath; // an executable absolute path → engineAvailable=true
const FLASH = "opencode-go/deepseek-v4.1-flash";

let home: string;
let collectEngineLimits: (c: JinnConfig, o?: { engine?: string }) => Promise<EngineLimitsResponse>;

function cfg(opencode: Record<string, unknown>): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: NODE, model: "opus" }, codex: { bin: NODE, model: "gpt-5.5" }, opencode },
    connectors: {},
  } as unknown as JinnConfig;
}

async function seedTurn(id: string, cost: number): Promise<void> {
  const { initDb } = await import("../db.js");
  const { recordTurnAccounting } = await import("../../sessions/registry.js");
  initDb().prepare(
    "INSERT INTO sessions (id, engine, model, source, source_ref, status, created_at, last_activity) VALUES (?, 'opencode', ?, 'web', ?, 'idle', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')",
  ).run(id, FLASH, `web:${id}`);
  recordTurnAccounting(id, { cost, numTurns: 1 });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-oc-limits-e2e-"));
  process.env.JINN_HOME = home; // frozen into paths.ts at first import below
  process.env.JINN_CLAUDE_USAGE_API = "off";
  ({ collectEngineLimits } = await import("../engine-limits.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  delete process.env.JINN_CLAUDE_USAGE_API;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("collectEngineLimits — opencode metered from the turn ledger", () => {
  it("stays unsupported, with a pointer to the setting, until an allowance is configured", async () => {
    const out = await collectEngineLimits(cfg({ bin: NODE, model: FLASH }), { engine: "opencode" });
    expect(out.engines.opencode.status).toBe("unsupported");
    expect(out.engines.opencode.unsupportedReason).toContain("engines.opencode.usageLimits");
  });

  it("meters jinn's opencode spend and marks the engine exhausted once a window is spent", async () => {
    const { readEngineHealth, isEngineExhausted } = await import("../engine-health.js");
    const config = cfg({ bin: NODE, model: FLASH, usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } });

    await seedTurn("oc-e2e-1", 6);
    let out = await collectEngineLimits(config, { engine: "opencode" });
    expect(out.engines.opencode.status).toBe("snapshot");
    expect(out.engines.opencode.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 50], ["7d", 20], ["30d", 10]]);
    expect(isEngineExhausted(readEngineHealth(), "opencode")).toBe(false);

    await seedTurn("oc-e2e-2", 6.5);
    out = await collectEngineLimits(config, { engine: "opencode" });
    const fiveHour = out.engines.opencode.windows?.[0];
    expect(fiveHour?.usedPercent).toBeGreaterThanOrEqual(100);
    // The $6 turn is the one whose ageing-out brings the window back under $12.
    expect(fiveHour?.resetsAt).toBeGreaterThan(Date.now() / 1000 + 4.9 * 3600);

    const health = readEngineHealth().opencode;
    expect(health).toMatchObject({ state: "exhausted", window: "5h", reason: "quota window spent" });
    expect(Date.parse(health!.until!)).toBe(fiveHour!.resetsAt! * 1000);
    expect(isEngineExhausted(readEngineHealth(), "opencode")).toBe(true);
  });

  it("keeps spend on the model that ran it when the engine default changes afterwards", async () => {
    const { initDb } = await import("../db.js");
    const { recordTurnAccounting } = await import("../../sessions/registry.js");
    initDb().prepare("DELETE FROM engine_spend").run();
    // Unpinned (model NULL on the row), run on the default of the day: FLASH.
    initDb().prepare(
      "INSERT INTO sessions (id, engine, model, source, source_ref, status, created_at, last_activity) VALUES ('oc-unpinned', 'opencode', NULL, 'web', 'web:oc-unpinned', 'idle', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')",
    ).run();
    recordTurnAccounting("oc-unpinned", { cost: 12.5, numTurns: 1, model: FLASH });

    const OTHER = "opencode-go/glm-5.3-flash";
    const out = await collectEngineLimits(
      cfg({ bin: NODE, model: OTHER, usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } }), { engine: "opencode" });
    // The new default has spent nothing; the old one keeps its spend.
    expect(out.engines.opencode.windows?.[0]).toMatchObject({ name: "5h", usedPercent: 0 });
    const flash = out.engines.opencode.buckets?.find((b) => b.id === FLASH);
    expect(flash?.windows?.[0]?.usedPercent).toBeGreaterThanOrEqual(100);
  });

  it("reads as unsupported, with the reason, when the default model is unmetered", async () => {
    const out = await collectEngineLimits(
      cfg({ bin: NODE, model: "openrouter/x", usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } }), { engine: "opencode" });
    expect(out.engines.opencode.status).toBe("unsupported");
    expect(out.engines.opencode.unsupportedReason).toMatch(/default model openrouter\/x matches no/);
    expect(out.engines.opencode.buckets?.length).toBeGreaterThan(0);
  });

  it("leaves Claude's own reading untouched by the opencode meter", async () => {
    const out = await collectEngineLimits(cfg({ bin: NODE, model: FLASH, usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } }), { engine: "claude" });
    expect(out.engines.claude.source).not.toContain("ledger");
    expect(out.engines.opencode).toBeUndefined();
  });
});
