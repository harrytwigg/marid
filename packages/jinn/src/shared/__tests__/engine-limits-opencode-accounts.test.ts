import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import type { Employee, EngineLimitEngineSnapshot, JinnConfig } from "../types.js";
import type { EngineSpendRow } from "../../sessions/engine-spend.js";

process.env.JINN_HOME = path.join(os.tmpdir(), `jinn-oc-accounts-limits-${process.pid}`);
const { collectOpencodeLimits, meteredLimitFor } = await import("../engine-limits-opencode.js");
const { collectOpencodeAccounts } = await import("../engine-limits-opencode-accounts.js");

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const row = (model: string | null, cost: number, hoursAgo: number): EngineSpendRow => ({ model, cost, atMs: NOW - hoursAgo * HOUR });

function cfg(opencode: Record<string, unknown> = {}): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "opus" }, opencode: { bin: process.execPath, model: "opencode-go/flash", ...opencode } },
    connectors: {},
  } as unknown as JinnConfig;
}

const ACCOUNTS = {
  "go-a": { provider: "opencode-go" },
  "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY", label: "Go (second)", usageLimits: { monthlyUsd: { "*": 100, pro: 15 } } },
  "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "GO_C_KEY" },
};

describe("meteredLimitFor", () => {
  it("meters an account's models by its own table: an exact model beats *", () => {
    const config = cfg({ accounts: ACCOUNTS });
    expect(meteredLimitFor(config, "opencode-go-b/flash")).toBe(100);
    expect(meteredLimitFor(config, "opencode-go-b/pro")).toBe(15);
  });

  it("lets an account with no limits inherit its base's engine-level keys, exact before *", () => {
    const config = cfg({ accounts: ACCOUNTS, usageLimits: { monthlyUsd: { "opencode-go/*": 60, "opencode-go/pro": 12 } } });
    expect(meteredLimitFor(config, "opencode-go-c/flash")).toBe(60);
    expect(meteredLimitFor(config, "opencode-go-c/pro")).toBe(12);
  });

  it("keeps the engine-level keys metering any provider directly, an account's included", () => {
    const config = cfg({ accounts: ACCOUNTS, usageLimits: { monthlyUsd: { "opencode-go/*": 60, "opencode-go-b/other": 7, "openrouter/*": 5 } } });
    expect(meteredLimitFor(config, "opencode-go/flash")).toBe(60);
    expect(meteredLimitFor(config, "openrouter/x")).toBe(5);
    // The account's own * wins over the engine's wildcard for its provider, but a key the account's table does
    // not name is still the engine-level one's.
    expect(meteredLimitFor(config, "opencode-go-b/other")).toBe(100);
  });

  it("does not inherit the base's keys into an account that declares limits not covering a model", () => {
    const config = cfg({
      accounts: { b: { provider: "opencode-go-b", base: "opencode-go", keyEnv: "K", usageLimits: { monthlyUsd: { pro: 15 } } } },
      usageLimits: { monthlyUsd: { "opencode-go/*": 60 } },
    });
    expect(meteredLimitFor(config, "opencode-go-b/pro")).toBe(15);
    expect(meteredLimitFor(config, "opencode-go-b/flash")).toBeUndefined();
  });

  it("meters nothing for an unmatched model, and a built-in account's own table covers its provider", () => {
    expect(meteredLimitFor(cfg({ accounts: ACCOUNTS }), "opencode-go-c/flash")).toBeUndefined();
    const config = cfg({ accounts: { "go-a": { provider: "opencode-go", usageLimits: { monthlyUsd: { "*": 30 } } } }, usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } });
    expect(meteredLimitFor(config, "opencode-go/flash")).toBe(30);
  });
});

describe("collectOpencodeLimits with accounts", () => {
  it("meters from account limits alone, with no engine-level table", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const snapshot = collectOpencodeLimits(config, { now: () => NOW, readSpend: () => [row("opencode-go-b/flash", 6, 1)] });
    expect(snapshot?.buckets?.map((bucket) => bucket.id)).toEqual(["opencode-go-b/flash", "opencode-go-b/pro"]);
    expect(snapshot?.buckets?.[0]?.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 30], ["7d", 12], ["30d", 6]]);
    // The default model (opencode-go/flash) is unmetered here, so the engine reads unsupported, with its reason.
    expect(snapshot?.status).toBe("unsupported");
  });

  it("keeps the top-level windows the default model's", () => {
    const config = cfg({ accounts: ACCOUNTS, usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } });
    const snapshot = collectOpencodeLimits(config, { now: () => NOW, readSpend: () => [row("opencode-go/flash", 6, 1), row("opencode-go-b/flash", 20, 1)] });
    expect(snapshot?.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 50], ["7d", 20], ["30d", 10]]);
    expect(snapshot?.buckets?.find((bucket) => bucket.id === "opencode-go-b/flash")?.windows?.[0]?.usedPercent).toBe(100);
  });

  it("is undefined when neither the engine nor any account meters anything", () => {
    expect(collectOpencodeLimits(cfg({ accounts: { "go-a": { provider: "opencode-go" } } }), { now: () => NOW, readSpend: () => [] })).toBeUndefined();
  });
});

describe("collectOpencodeAccounts", () => {
  const employees = [
    { name: "pinned-b", engine: "opencode", model: "opencode-go-b/flash" },
    { name: "unpinned", engine: "opencode" },
    { name: "on-claude", engine: "claude", model: "opencode-go-b/flash" },
    { name: "on-c", engine: "opencode", model: "opencode-go-c/flash" },
  ] as Employee[];
  const engine = (config: JinnConfig, spend: EngineSpendRow[]): EngineLimitEngineSnapshot => collectOpencodeLimits(config, { now: () => NOW, readSpend: () => spend })!;

  it("is undefined with no declared account", () => {
    expect(collectOpencodeAccounts(cfg({ usageLimits: { monthlyUsd: { "*": 1 } } }), engine(cfg({ usageLimits: { monthlyUsd: { "*": 1 } } }), []), { employees })).toBeUndefined();
  });

  it("returns one entry per declared account, built-in ones included, sorted by name", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const out = collectOpencodeAccounts(config, engine(config, []), { employees, env: { GO_B_KEY: "sentinel-secret-value" }, health: {}, now: new Date(NOW) })!;
    expect(out.map((account) => account.account)).toEqual(["go-a", "go-b", "go-c"]);
    const [a, b, c] = out;
    expect(a).toMatchObject({ provider: "opencode-go", label: "go-a", location: { kind: "local" }, buckets: [] });
    expect(a).not.toHaveProperty("keyEnv");
    expect(b).toMatchObject({ provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY", keySet: true, label: "Go (second)" });
    expect(c).toMatchObject({ keyEnv: "GO_C_KEY", keySet: false, problems: ['account "go-c" has no key: GO_C_KEY is not set'] });
    // The value of the key is never in the response.
    expect(JSON.stringify(out)).not.toContain("sentinel-secret-value");
  });

  it("lists the employees whose own model is on the provider, an unpinned one by the engine's model", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const out = collectOpencodeAccounts(config, engine(config, []), { employees, env: {}, health: {}, now: new Date(NOW) })!;
    expect(out.find((account) => account.account === "go-a")?.employees).toEqual(["unpinned"]);
    expect(out.find((account) => account.account === "go-b")?.employees).toEqual(["pinned-b"]);
    expect(out.find((account) => account.account === "go-c")?.employees).toEqual(["on-c"]);
  });

  it("reads a one-shot roster (a Map's values) once, for every account", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const roster = new Map(employees.map((employee) => [employee.name, employee])).values();
    const out = collectOpencodeAccounts(config, engine(config, []), { employees: roster, env: {}, health: {}, now: new Date(NOW) })!;
    expect(out.map((account) => account.employees)).toEqual([["unpinned"], ["pinned-b"], ["on-c"]]);
  });

  it("carries only the account's own metered models as buckets", () => {
    const config = cfg({ accounts: ACCOUNTS, usageLimits: { monthlyUsd: { "opencode-go/*": 60 } } });
    const out = collectOpencodeAccounts(config, engine(config, [row("opencode-go/flash", 1, 1), row("opencode-go-b/flash", 2, 1)]), { employees, env: {}, health: {}, now: new Date(NOW) })!;
    expect(out.find((account) => account.account === "go-a")?.buckets.map((bucket) => bucket.id)).toEqual(["opencode-go/flash"]);
    expect(out.find((account) => account.account === "go-b")?.buckets.map((bucket) => bucket.id)).toEqual(["opencode-go-b/flash", "opencode-go-b/pro"]);
  });

  it("reports health's hold on the provider: exhausted, until, and the next try (recheckAt, else until)", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const until = new Date(NOW + 5 * HOUR).toISOString();
    const recheckAt = new Date(NOW + 2 * HOUR).toISOString();
    const out = collectOpencodeAccounts(config, engine(config, []), {
      employees, env: {}, now: new Date(NOW),
      health: { "opencode/opencode-go-b": { state: "exhausted", until, recheckAt }, "opencode/opencode-go-c": { state: "exhausted", until } },
    })!;
    const byName = new Map(out.map((account) => [account.account, account]));
    expect(byName.get("go-b")).toMatchObject({ exhausted: { until }, nextTryAt: recheckAt });
    expect(byName.get("go-c")).toMatchObject({ exhausted: { until }, nextTryAt: until });
    expect(byName.get("go-a")).not.toHaveProperty("exhausted");
    expect(byName.get("go-a")).not.toHaveProperty("nextTryAt");
  });

  it("reads the engine-wide record as holding every account, and the binding one (the later reopening) of it and the account's own key as the account's hold", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const wide = new Date(NOW + 5 * HOUR).toISOString();
    const earlier = new Date(NOW + 2 * HOUR).toISOString();
    const later = new Date(NOW + 9 * HOUR).toISOString();
    const out = collectOpencodeAccounts(config, engine(config, []), {
      employees, env: {}, now: new Date(NOW),
      health: { opencode: { state: "exhausted", until: wide }, "opencode/opencode-go-b": { state: "exhausted", until: earlier }, "opencode/opencode-go-c": { state: "exhausted", until: later } },
    })!;
    const byName = new Map(out.map((account) => [account.account, account]));
    expect(byName.get("go-a")).toMatchObject({ exhausted: { until: wide }, nextTryAt: wide });
    // The engine is out until `wide`, whatever the account's own earlier record says.
    expect(byName.get("go-b")).toMatchObject({ exhausted: { until: wide }, nextTryAt: wide });
    expect(byName.get("go-c")).toMatchObject({ exhausted: { until: later }, nextTryAt: later });
  });

  it("takes nextTryAt from the binding record, not from whichever key was read first", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const ownUntil = new Date(NOW + 3 * HOUR).toISOString();
    const ownRecheck = new Date(NOW + 1 * HOUR).toISOString();
    const wideUntil = new Date(NOW + 8 * HOUR).toISOString();
    const wideRecheck = new Date(NOW + 6 * HOUR).toISOString();
    const out = collectOpencodeAccounts(config, engine(config, []), {
      employees, env: {}, now: new Date(NOW),
      health: {
        "opencode/opencode-go-b": { state: "exhausted", until: ownUntil, recheckAt: ownRecheck },
        opencode: { state: "exhausted", until: wideUntil, recheckAt: wideRecheck },
      },
    })!;
    expect(out.find((account) => account.account === "go-b")).toMatchObject({ exhausted: { until: wideUntil }, nextTryAt: wideRecheck });
  });

  it("does not read a degraded or lapsed record as exhausted", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const out = collectOpencodeAccounts(config, engine(config, []), {
      employees, env: {}, now: new Date(NOW),
      health: {
        "opencode/opencode-go-b": { state: "degraded", until: new Date(NOW + HOUR).toISOString() },
        "opencode/opencode-go-c": { state: "exhausted", until: new Date(NOW + HOUR).toISOString(), recheckAt: new Date(NOW - HOUR).toISOString() },
      },
    })!;
    expect(out.every((account) => account.exhausted === undefined)).toBe(true);
  });

  describe("lastFailure", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const until = new Date(NOW + HOUR).toISOString();
    const seen = (offset: number) => new Date(NOW + offset).toISOString();
    const card = (health: Record<string, unknown>, account = "go-b") =>
      collectOpencodeAccounts(config, engine(config, []), { employees, env: {}, now: new Date(NOW), health: health as never })!.find((a) => a.account === account)!;

    it("carries the class, when it was seen and why, from the provider's record", () => {
      const out = card({ "opencode/opencode-go-b": { state: "exhausted", until, failureClass: "quota", observedAt: seen(-5 * 60_000), reason: "Insufficient account funds" } });
      expect(out.lastFailure).toEqual({ class: "quota", at: seen(-5 * 60_000), reason: "Insufficient account funds" });
      expect(out.nextTryAt).toBe(until);
    });

    it("takes the newest of the provider's record and its models' records", () => {
      const out = card({
        "opencode/opencode-go-b": { state: "exhausted", until, failureClass: "quota", observedAt: seen(-30 * 60_000) },
        "opencode/opencode-go-b/flash": { state: "exhausted", until, failureClass: "model-access", observedAt: seen(-60_000), reason: "Model access is disabled" },
        "opencode/opencode-go-c/flash": { state: "exhausted", until, failureClass: "auth", observedAt: seen(-1000) },
      });
      expect(out.lastFailure).toMatchObject({ class: "model-access", at: seen(-60_000) });
    });

    it("is absent with no classed hold in force, and never carries the credential's identity", () => {
      expect(card({}).lastFailure).toBeUndefined();
      expect(card({ "opencode/opencode-go-b": { state: "exhausted", until, observedAt: seen(-1000) } }).lastFailure).toBeUndefined();
      expect(card({ "opencode/opencode-go-b": { state: "ok", observedAt: seen(-HOUR) } }).lastFailure).toBeUndefined();
      const out = card({ "opencode/opencode-go-b": { state: "exhausted", until, failureClass: "auth", observedAt: seen(-1000), credentialFingerprint: "abcd1234" } });
      expect(JSON.stringify(out)).not.toContain("abcd1234");
    });
  });
});
