import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { JinnConfig } from "../../shared/types.js";
import { baseConfig, call, home, loadApi, registry, resetFallbackFixture, setConfig, unloadApi } from "./session-fallback-api-harness.js";

/**
 * Fallback chains over HTTP: GET /api/fallback-chains, an employee's `fallback` through the org PATCH,
 * the loader's refusal through PUT /api/config, and the `fallback.chain` on a session.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(() => {
  resetFallbackFixture();
  setConfig(chainConfig());
  writeEmployee(undefined);
});

const DIR_A = "/srv/operator/.claude-a";
const DIR_B = "/srv/operator/.claude-b";
const WORKER_FILE = path.join(home, "org", "a-worker.yaml");

/** claude/A/opus → claude/B/sonnet → opencode/X → opencode/Y, on the default chain. */
function chainConfig(fallback: unknown[] = [
  { engine: "claude", profile: "A", model: "opus" },
  { engine: "claude", profile: "B", model: "sonnet" },
  { engine: "opencode", model: "openrouter/x" },
  { engine: "opencode", model: "opencode-go/y" },
]): JinnConfig {
  return {
    ...baseConfig,
    engines: {
      ...baseConfig.engines,
      claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } }, fallback },
      opencode: { bin: "opencode", model: "opencode/big-pickle" },
    },
    models: {
      ...baseConfig.models,
      claude: { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] },
    },
  } as unknown as JinnConfig;
}

function writeEmployee(fallback: unknown): void {
  const base = { name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "claude", model: "opus", persona: "Fallback mode fixture" };
  fs.writeFileSync(WORKER_FILE, yaml.dump(fallback === undefined ? base : { ...base, fallback }));
}

const workerYaml = () => yaml.load(fs.readFileSync(WORKER_FILE, "utf-8")) as Record<string, unknown>;
const subject = (body: any, kind: string, id: string) => body.subjects.find((s: any) => s.kind === kind && s.id === id);
const keys = (links: Array<{ key: string }>) => links.map((link) => link.key);

describe("GET /api/fallback-chains", () => {
  it("lists the declared profiles and every engine's and account's chain, effective in written order", async () => {
    const got = await call("GET", "/api/fallback-chains");
    expect(got.status).toBe(200);
    expect(got.body.profiles.map((p: any) => [p.name, p.configDir])).toEqual([["A", DIR_A], ["B", DIR_B]]);
    expect(got.body.subjects.map((s: any) => `${s.kind}:${s.id}`)).toEqual(expect.arrayContaining(["engine:claude", "engine:codex", "engine:opencode", "account:A", "account:B"]));
    const claude = subject(got.body, "engine", "claude");
    expect(keys(claude.effective)).toEqual(["claude|A|opus", "claude|B|sonnet", "opencode||openrouter/x", "opencode||opencode-go/y"]);
    expect(claude.effective.map((l: any) => l.label)).toEqual(["claude · A · opus", "claude · B · sonnet", "opencode · openrouter/x", "opencode · opencode-go/y"]);
    expect(claude.effective.map((l: any) => l.account)).toEqual([expect.stringMatching(/^claude:/), expect.stringMatching(/^claude:/), "opencode", "opencode"]);
    expect(claude).toMatchObject({ legacy: false, primary: { key: "claude||opus" } });
    expect(claude.configured).toHaveLength(4);
    expect(subject(got.body, "engine", "codex")).toMatchObject({ configured: null, effective: [] });
    expect(got.body.subjects.some((s: any) => s.kind === "employee")).toBe(false);
  });

  it("reports a legacy chain as written, flags it, and shows the expanded order", async () => {
    setConfig(chainConfig(["codex", "claude:A"]));
    const claude = subject((await call("GET", "/api/fallback-chains")).body, "engine", "claude");
    expect(claude.legacy).toBe(true);
    expect(claude.configured).toEqual([{ engine: "codex" }, { engine: "claude", profile: "A" }]);
    expect(keys(claude.effective)).toEqual(["codex||", "claude|A|opus"]);
  });

  it("an employee chain overrides it, here and in the session view", async () => {
    const before = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(before).toMatchObject({ configured: null, primary: { key: "claude||opus" } });
    expect(keys(before.effective)).toHaveLength(4);

    const patch = await call("PATCH", "/api/org/employees/a-worker", { fallback: [{ engine: "claude", profile: "B", model: "sonnet" }] });
    expect(patch.status).toBe(200);
    expect(workerYaml().fallback).toEqual([{ engine: "claude", profile: "B", model: "sonnet" }]);

    const after = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(after.configured).toEqual([{ engine: "claude", profile: "B", model: "sonnet" }]);
    expect(keys(after.effective)).toEqual(["claude|B|sonnet"]);

    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:chain-employee", model: "opus", employee: "a-worker" });
    const view = (await call("GET", `/api/sessions/${session.id}`)).body.fallback.chain;
    expect(view.source).toBe("employee");
    expect(keys(view.links)).toEqual(["claude||opus", "claude|B|sonnet"]);
  });

  it("shows why a chain written in the employee's YAML was ignored, and drops it once a valid one is saved", async () => {
    writeEmployee([{ engine: "codex" }, { engine: "codex" }]);
    const { refreshOrg } = await import("../org-registry.js");
    refreshOrg(chainConfig());
    const ignored = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(ignored.configured).toBeNull();
    expect(ignored.problems).toEqual(["fallback[1] duplicates fallback[0] (codex): a chain tries each target once, so list it once"]);
    expect(keys(ignored.effective)).toHaveLength(4);

    await call("PATCH", "/api/org/employees/a-worker", { fallback: [{ engine: "codex" }] });
    const fixed = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(fixed).not.toHaveProperty("problems");
    expect(keys(fixed.effective)).toEqual(["codex||"]);
  });

  it("answers 404 for an employee that does not exist", async () => {
    expect((await call("GET", "/api/fallback-chains?employee=nobody")).status).toBe(404);
  });
});

describe("PATCH /api/org/employees/:name with fallback", () => {
  it("null removes it so the employee inherits, and [] writes no fallback", async () => {
    writeEmployee([{ engine: "codex" }]);
    expect((await call("PATCH", "/api/org/employees/a-worker", { fallback: [] })).status).toBe(200);
    expect(workerYaml().fallback).toEqual([]);
    const none = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(none).toMatchObject({ configured: [], effective: [] });

    expect((await call("PATCH", "/api/org/employees/a-worker", { fallback: null })).status).toBe(200);
    expect(workerYaml()).not.toHaveProperty("fallback");
  });

  it("refuses a duplicate target with the wire module's sentence, and writes nothing", async () => {
    const dup = [{ engine: "codex", model: "gpt-mapped" }, { engine: "codex", model: "gpt-mapped" }];
    const got = await call("PATCH", "/api/org/employees/a-worker", { fallback: dup });
    expect(got.status).toBe(400);
    expect(got.body.error).toBe("fallback[1] duplicates fallback[0] (codex · gpt-mapped): a chain tries each target once, so list it once");
    expect(workerYaml()).not.toHaveProperty("fallback");
  });

  it("refuses a link with no model on the employee's own engine, which is its own target", async () => {
    const got = await call("PATCH", "/api/org/employees/a-worker", { fallback: [{ engine: "claude" }] });
    expect(got.status).toBe(400);
    expect(got.body.error).toContain("is the target this chain falls back from");
    expect(workerYaml()).not.toHaveProperty("fallback");
  });

  it("refuses an engine or model change that would leave the stored chain naming the employee's own target", async () => {
    writeEmployee([{ engine: "codex", model: "gpt-mapped" }]);
    const refused = await call("PATCH", "/api/org/employees/a-worker", { engine: "codex", model: "gpt-mapped" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("the engine or model change leaves the employee's fallback invalid");
    expect(workerYaml()).toMatchObject({ engine: "claude", fallback: [{ engine: "codex", model: "gpt-mapped" }] });
    // Sending the chain with it, or an unrelated change, is fine.
    expect((await call("PATCH", "/api/org/employees/a-worker", { engine: "codex", model: "gpt-mapped", fallback: null })).status).toBe(200);
    expect((await call("PATCH", "/api/org/employees/a-worker", { displayName: "Renamed" })).status).toBe(200);
  });

  it("refuses the employee's own target, an unknown engine or profile, a string entry and a non-list", async () => {
    const refuse = async (fallback: unknown) => (await call("PATCH", "/api/org/employees/a-worker", { fallback })).body.error as string;
    expect(await refuse([{ engine: "claude", model: "opus" }])).toContain("is the target this chain falls back from");
    expect(await refuse([{ engine: "gemini" }])).toContain('"gemini" is not a known engine');
    expect(await refuse([{ engine: "claude", profile: "ghost" }])).toContain('profile "ghost" names no account');
    expect(await refuse(["codex"])).toContain("must be a mapping with engine, profile and model");
    expect(await refuse("codex")).toBe("fallback must be a list of fallback targets");
  });
});

describe("PUT /api/config", () => {
  it("refuses a duplicate target with the wire module's sentence", async () => {
    const put = await call("PUT", "/api/config", { engines: { claude: { fallback: [{ engine: "codex" }, "codex"] } } });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain("engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex)");
  });

  it("refuses an account chain naming the account itself", async () => {
    const put = await call("PUT", "/api/config", { engines: { claude: { accounts: { A: { configDir: DIR_A, fallback: [{ engine: "claude", profile: "A" }] } } } } });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain("is the target this chain falls back from");
  });
});

describe("GET /api/sessions/:id fallback.chain", () => {
  it("with no run sits at position 0, with the first usable link next", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:chain-idle", model: "opus" });
    const chain = (await call("GET", `/api/sessions/${session.id}`)).body.fallback.chain;
    expect(chain).toMatchObject({ source: "engine", position: 0, servedBy: null, next: "claude|A|opus", hops: [] });
    expect(keys(chain.links)).toEqual(["claude||opus", "claude|A|opus", "claude|B|sonnet", "opencode||openrouter/x", "opencode||opencode-go/y"]);
  });

  it("reads the run, the hops and the target that served the last turn from the session", async () => {
    const hop = { at: "2026-10-19T10:00:00.000Z", from: "claude||opus", to: "claude|A|opus", fromLabel: "claude · opus", toLabel: "claude · A · opus", reason: "rate-limit" };
    const session = registry.createSession({
      engine: "claude", source: "web", sourceRef: "web:chain-run", model: "opus",
      transportMeta: {
        fallbackRun: { source: "engine", position: 1, tried: ["claude||opus", "claude|A|opus"], startedAt: hop.at },
        fallbackHops: [hop, { garbage: true }],
        fallbackServedBy: { key: "claude|A|opus", label: "claude · A · opus", at: hop.at },
      },
    });
    const chain = (await call("GET", `/api/sessions/${session.id}`)).body.fallback.chain;
    expect(chain).toMatchObject({ position: 1, servedBy: "claude|A|opus", next: "claude|B|sonnet" });
    expect(chain.hops).toEqual([hop]);
  });
});
