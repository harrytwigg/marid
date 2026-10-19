import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";

/** A new session whose target is out of allowance starts on the first healthy link of its chain, with a run that starts there. */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  getModelRegistry: () => ({}),
}));
import { rerouteAtCreation } from "../fallback-reroute.js";
import { reroutedSessionMeta } from "../engine-override-window.js";
import { availabilityRegistry } from "../availability-registry.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

const NOW = new Date("2026-10-19T10:00:00.000Z");
const HOUR = 3600_000;
const spent = (hours = 1) => ({ state: "exhausted" as const, until: new Date(NOW.getTime() + hours * HOUR).toISOString(), recheckAt: new Date(NOW.getTime() + hours * HOUR).toISOString() });
const WORK = path.join(os.tmpdir(), "claude-reroute-work");
const workKey = `claude:${claudeProfileFromDir(WORK).key}`;

const config = (claude: Record<string, unknown> = {}) => ({
  engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { work: { configDir: WORK } }, ...claude }, codex: { bin: "codex", model: "gpt" }, opencode: { bin: "opencode" } },
}) as unknown as JinnConfig;
const installed = (...names: string[]) => availabilityRegistry({}, (name) => names.includes(name));
const args = (over: Record<string, unknown> = {}) => ({
  config: config({ fallback: ["codex"] }), engine: "claude", model: "opus", registry: installed("claude", "codex", "opencode"), health: {}, scope: { scoped: false, remote: false }, now: NOW, ...over,
});

describe("rerouteAtCreation", () => {
  it("leaves a target with allowance where it is", () => {
    expect(rerouteAtCreation(args())).toBeUndefined();
    expect(rerouteAtCreation(args({ health: { claude: { state: "degraded", until: spent().until } } }))).toBeUndefined();
  });

  it("starts on the first healthy link, recording the way back and a run that starts at that link", () => {
    const choice = rerouteAtCreation(args({ health: { claude: spent(2) } }))!;
    expect(choice.engine).toBe("codex");
    expect(choice.reroute).toMatchObject({
      from: "claude", model: "opus", target: { engine: "codex" },
      run: { source: "engine", position: 1, tried: ["claude||opus"], startedAt: NOW.toISOString() },
    });
    expect(choice.reroute.until.getTime()).toBe(NOW.getTime() + 2 * HOUR);
  });

  it("skips a link at its limit, and one that cannot be used", () => {
    const choice = rerouteAtCreation(args({
      config: config({ fallback: ["codex", "opencode", "claude:work"] }), registry: installed("claude", "opencode"),
      health: { claude: spent(), opencode: spent() },
    }))!;
    // codex is not installed, opencode is out: the account link is next.
    expect(choice).toMatchObject({ engine: "claude", reroute: { account: { substitute: workKey, configDir: WORK }, run: { position: 3 } } });
  });

  it("hands the preference back when nothing in the chain is healthy and usable", () => {
    expect(rerouteAtCreation(args({ health: { claude: spent(), codex: spent() } }))).toBeUndefined();
    expect(rerouteAtCreation(args({ registry: installed("claude"), health: { claude: spent() } }))).toBeUndefined();
    expect(rerouteAtCreation(args({ config: config(), health: { claude: spent() } }))).toBeUndefined();
  });

  it("takes the employee's chain over the engine's, and the model its link names", () => {
    const employee = { name: "e", engine: "claude", fallback: [{ engine: "opencode", model: "x/model-x" }] } as Employee;
    const choice = rerouteAtCreation(args({ employee, health: { claude: spent() } }))!;
    expect(choice).toMatchObject({ engine: "opencode", model: "x/model-x", reroute: { run: { source: "employee" }, target: { engine: "opencode", model: "x/model-x" } } });
  });

  it("does not carry the target's model to another engine, and reads the model a link inherits as none", () => {
    expect(rerouteAtCreation(args({ health: { claude: spent() } }))!.model).toBeUndefined();
  });

  it("holds an opencode target's limit under its provider", () => {
    const choice = rerouteAtCreation(args({
      engine: "opencode", model: "x/model-x", config: config({}), registry: installed("claude", "opencode"),
      employee: { name: "o", engine: "opencode", fallback: [{ engine: "opencode", model: "y/model-y" }, { engine: "claude" }] } as Employee,
      health: { "opencode/x": spent() },
    }))!;
    expect(choice.engine).toBe("opencode");
    expect(choice.model).toBe("y/model-y");
  });

  it("never lands on a non-Claude link for a department-scoped session", () => {
    expect(rerouteAtCreation(args({ scope: { scoped: true, remote: false }, health: { claude: spent() } }))).toBeUndefined();
  });

  it("turns into the override a swap parks, plus the run", () => {
    const choice = rerouteAtCreation(args({ health: { claude: spent() } }))!;
    expect(reroutedSessionMeta(choice.reroute, { kept: true }, NOW)).toEqual({
      kept: true,
      engineOverride: {
        originalEngine: "claude", originalEngineSessionId: null, originalModel: "opus", until: choice.reroute.until.toISOString(), syncSince: NOW.toISOString(),
        substituteTarget: { engine: "codex" },
      },
      fallbackRun: { source: "engine", position: 1, tried: ["claude||opus"], startedAt: NOW.toISOString() },
    });
  });

  it("records another Claude account as an account swap on the override", () => {
    const choice = rerouteAtCreation(args({ config: config({ fallback: ["claude:work"] }), health: { claude: spent() } }))!;
    expect(reroutedSessionMeta(choice.reroute, null, NOW)).toMatchObject({
      engineOverride: { originalAccount: "claude", substituteAccount: workKey, substituteConfigDir: WORK, substituteTarget: { engine: "claude", profile: "work" } },
    });
  });
});
