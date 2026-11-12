import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `jinn limits` prints a card for every account the response carries: opencode's declared ones and Claude's, which it used to skip. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-limits-accounts-"));
process.env.JINN_HOME = tmp;
const collect = vi.fn();
vi.mock("../../shared/engine-limits.js", () => ({ collectEngineLimits: (...args: unknown[]) => collect(...args) }));
vi.mock("../../shared/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../shared/config.js")>()), loadConfig: () => ({ engines: {} }) }));
vi.mock("../../shared/models.js", async (importOriginal) => {
  const none = async () => {};
  return { ...(await importOriginal<typeof import("../../shared/models.js")>()), refreshPiModels: none, refreshOpencodeModels: none, refreshGrokModels: none, refreshMusecodeModels: none, refreshHermesModels: none };
});

const { runLimits } = await import("../limits.js");

const window = (name: string, usedPercent: number, mins: number, resetsAtIso?: string) => ({ name, usedPercent, windowDurationMins: mins, ...(resetsAtIso ? { resetsAtIso } : {}) });
const base = { available: true, status: "snapshot", source: "jinn turn ledger", refreshedAt: "2026-11-12T10:00:00.000Z", models: [] };

const RESPONSE = {
  generatedAt: "2026-11-12T10:00:00.000Z", default: "claude",
  engines: { opencode: { ...base, name: "opencode" } },
  accounts: {
    claude: [
      { ...base, name: "claude", account: "claude", label: "claude", location: { kind: "local" }, employees: [], windows: [window("5h", 12, 300)] },
      { ...base, name: "claude", account: "claude:work", label: "work", location: { kind: "remote", host: "build@box" }, employees: ["ana", "bo"], windows: [window("7d", 100, 10080, "2026-11-14T00:00:00.000Z")], exhausted: { until: "2026-11-14T00:00:00.000Z" }, hostUnreachable: true },
    ],
    opencode: [
      {
        ...base, name: "opencode", account: "go-b", label: "Go (second)", location: { kind: "local" }, employees: ["worker"],
        provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY", keySet: false,
        buckets: [{ id: "opencode-go-b/flash", name: "opencode-go-b/flash", planType: "$60/month", windows: [window("5h", 100, 300, "2026-11-12T15:00:00.000Z")] }],
        exhausted: { until: "2026-11-12T15:00:00.000Z" }, nextTryAt: "2026-11-12T13:00:00.000Z", problems: ["GO_B_KEY is not set in the gateway's environment"],
      },
      { ...base, name: "opencode", account: "go-a", label: "go-a", location: { kind: "local" }, employees: [], provider: "opencode-go", buckets: [] },
    ],
  },
};

let out: string[];
beforeEach(() => {
  out = [];
  collect.mockReset();
  collect.mockResolvedValue(RESPONSE);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

describe("jinn limits account cards", () => {
  it("prints a card per opencode account: provider, key state, buckets, hold, next try and problems", async () => {
    await runLimits({});
    const text = out.join("\n");
    const card = text.slice(text.indexOf("opencode account go-b"));
    expect(card).toContain("opencode account go-b (Go (second)) (local)");
    expect(card).toContain("Provider: opencode-go-b (clones opencode-go)");
    expect(card).toContain("Key: GO_B_KEY (NOT SET)");
    expect(card).toContain("Employees: worker");
    expect(card).toMatch(/opencode-go-b\/flash, plan \$60\/month\n\s+5h\/5h: 100% used, resets /);
    expect(card).toMatch(/Exhausted until /);
    expect(card).toMatch(/Next try: /);
    expect(card).toContain("Problem: GO_B_KEY is not set in the gateway's environment");
  });

  it("prints a card for a built-in provider's account too", async () => {
    await runLimits({});
    expect(out.join("\n")).toContain("opencode account go-a (local)\n  Provider: opencode-go");
  });

  it("prints Claude's accounts, which it skipped before", async () => {
    await runLimits({});
    const text = out.join("\n");
    expect(text).toContain("claude account claude (local)");
    expect(text).toContain("claude account claude:work (work) (remote build@box)");
    expect(text).toContain("Employees: ana, bo");
    expect(text).toMatch(/7d\/7d: 100% used, resets /);
    expect(text).toContain("the host did not answer");
  });

  it("prints no account card when the response carries none", async () => {
    collect.mockResolvedValue({ ...RESPONSE, accounts: undefined });
    await runLimits({});
    expect(out.join("\n")).not.toContain("account ");
  });

  it("hands --json the response unchanged, accounts included", async () => {
    await runLimits({ json: true });
    expect(JSON.parse(out.join("\n"))).toEqual(RESPONSE);
  });
});
