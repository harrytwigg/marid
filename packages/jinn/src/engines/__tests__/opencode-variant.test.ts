import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { buildOpencodeArgs, describeOpencodeLaunch } from "../opencode-protocol.js";
import { runFlagsFor } from "../opencode-launch.js";
import {
  modelWithVariant,
  runVariantOf,
  sameModelRef,
  unsupportedServerFlags,
  variantFromCliFlags,
  variantOf,
  withKnownEffort,
} from "../opencode-variant.js";
import { clearOpencodeVersionCache } from "../../shared/opencode-bin-version.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";

/**
 * Reasoning effort reaches opencode as the model's variant, in every mode, and
 * only when the registry lists it for the model the turn runs on.
 */

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode.mjs");
const FAKE_V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode-v2.mjs");

/** What the registry would list: a model with five variants, one with one, one with none. */
const LEVELS: Record<string, string[]> = {
  "mock/five": ["low", "medium", "high", "xhigh", "max"],
  "mock/one": ["high"],
};
const levelsOf = (model: string | undefined) => (model ? LEVELS[model] ?? [] : []);

const opts = (over: Partial<EngineRunOpts> = {}): EngineRunOpts => ({ prompt: "p", cwd: "/work", model: "mock/five", ...over });

describe("withKnownEffort", () => {
  it("keeps an effort the turn's model lists", () => {
    const given = opts({ effortLevel: "xhigh" });
    expect(withKnownEffort(given, levelsOf)).toBe(given);
  });

  it("takes off an effort the model does not list, and logs it", () => {
    expect(withKnownEffort(opts({ model: "mock/one", effortLevel: "low" }), levelsOf).effortLevel).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('effort "low" is not a variant of mock/one'));
  });

  it("takes off any effort for a model with no levels, an unlisted model and no model", () => {
    expect(withKnownEffort(opts({ model: "mock/none", effortLevel: "high" }), levelsOf).effortLevel).toBeUndefined();
    expect(withKnownEffort(opts({ model: "mock/unlisted", effortLevel: "high" }), levelsOf).effortLevel).toBeUndefined();
    expect(withKnownEffort(opts({ model: undefined, effortLevel: "high" }), levelsOf).effortLevel).toBeUndefined();
  });

  it("leaves a turn with no effort, or the default, alone", () => {
    for (const effortLevel of [undefined, "", "default"]) {
      const given = opts({ effortLevel });
      expect(variantOf(withKnownEffort(given, levelsOf))).toBeUndefined();
    }
  });
});

describe("variantFromCliFlags / variantOf", () => {
  it("reads --variant in both spellings, the last one winning", () => {
    expect(variantFromCliFlags(["--variant", "max"])).toBe("max");
    expect(variantFromCliFlags(["--variant=low"])).toBe("low");
    expect(variantFromCliFlags(["--variant", "low", "--variant=high"])).toBe("high");
    expect(variantFromCliFlags(["--agent", "x"])).toBeUndefined();
    expect(variantFromCliFlags(["--variant"])).toBeUndefined();
    expect(variantFromCliFlags(undefined)).toBeUndefined();
  });

  it("prefers the operator's flag to the turn's effort", () => {
    expect(variantOf({ effortLevel: "high", cliFlags: ["--variant", "max"] })).toBe("max");
    expect(variantOf({ effortLevel: "high" })).toBe("high");
    expect(variantOf({ effortLevel: "default" })).toBeUndefined();
    expect(runVariantOf({ effortLevel: "high", cliFlags: ["--variant", "max"] })).toBeUndefined();
    expect(runVariantOf({ effortLevel: "high" })).toBe("high");
  });

  it("names the flags server mode has no equivalent for", () => {
    expect(unsupportedServerFlags(["--agent", "plan", "--variant", "high", "--variant=low"])).toEqual([]);
    expect(unsupportedServerFlags(["--agent", "plan", "--thinking", "--variant", "high"])).toEqual(["--thinking"]);
    expect(unsupportedServerFlags(undefined)).toEqual([]);
  });
});

describe("sameModelRef", () => {
  const want = { providerID: "mock", id: "five" };
  it("treats a missing, empty or \"default\" variant as none, as the 2.x server reports it", () => {
    for (const variant of [undefined, "", "default"]) expect(sameModelRef({ providerID: "mock", id: "five", variant }, want)).toBe(true);
    expect(sameModelRef({ providerID: "mock", id: "five", variant: "high" }, want)).toBe(false);
    expect(sameModelRef({ providerID: "mock", id: "five", variant: "high" }, { ...want, variant: "high" })).toBe(true);
    expect(sameModelRef({ providerID: "mock", id: "five" }, { ...want, variant: "high" })).toBe(false);
    expect(sameModelRef({ providerID: "mock", id: "other" }, want)).toBe(false);
    expect(sameModelRef(undefined, want)).toBe(false);
  });
});

describe("the run argv", () => {
  const argv = (o: EngineRunOpts, api: 1 | 2 = 1) => buildOpencodeArgs(o, runFlagsFor(api));

  it("1.x: --variant after -m", () => {
    expect(argv(opts({ effortLevel: "high" }))).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "-m", "mock/five", "--variant", "high"]);
  });

  it("2.x: the variant rides on the model, and there is no --variant", () => {
    const args = argv(opts({ effortLevel: "high", resumeSessionId: "ses_1" }), 2);
    expect(args).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "--standalone", "-m", "mock/five#high", "-s", "ses_1"]);
    expect(args).not.toContain("--variant");
  });

  it("sends none for no effort, the default, or no model", () => {
    for (const effortLevel of [undefined, "default", ""]) {
      expect(argv(opts({ effortLevel }))).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "-m", "mock/five"]);
      expect(argv(opts({ effortLevel }), 2)).toContain("mock/five");
    }
    expect(argv(opts({ model: undefined, effortLevel: "high" }))).toEqual(["run", "--format", "json", "--dangerously-skip-permissions"]);
  });

  it("lets an explicit --variant in cliFlags win, on either API", () => {
    const flags = { effortLevel: "high", cliFlags: ["--variant", "max"] };
    expect(argv(opts(flags)).filter((a) => a === "--variant")).toHaveLength(1);
    expect(argv(opts(flags)).join(" ")).toContain("-m mock/five --variant max");
    expect(argv(opts(flags), 2).join(" ")).toContain("-m mock/five --variant max");
    expect(argv(opts(flags), 2)).not.toContain("mock/five#high");
  });

  it("is named in the launch log line", () => {
    expect(describeOpencodeLaunch(opts({ effortLevel: "high" }))).toBe("-m mock/five (variant high)");
    expect(describeOpencodeLaunch(opts())).toBe("-m mock/five");
    expect(modelWithVariant("a/b", undefined)).toBe("a/b");
  });
});

// ── Through the engine, against the fake binaries ──────────────────────────

let harnesses: Array<{ engine: OpencodeEngine; pool: OpencodeServerPool }> = [];
const tmp = os.tmpdir();
const runLog = path.join(tmp, `opencode-variant-runs-${process.pid}.log`);

function harness(bin: string, mode: "run" | "server", effortLevels: (m: string | undefined) => readonly string[] = levelsOf) {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { limits: () => ({}), bin: () => bin });
  const engine = new OpencodeEngine({ mode: () => mode, servers: pool, effortLevels: () => effortLevels });
  harnesses.push({ engine, pool });
  return { engine, pool };
}

const runOpts = (bin: string, over: Partial<EngineRunOpts> = {}): EngineRunOpts =>
  ({ prompt: "build it", cwd: JINN_HOME, sessionId: "sess-1", bin, model: "mock/five", ...over });

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await check(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  fs.rmSync(runLog, { force: true });
  process.env.FAKE_OPENCODE_RUN_LOG = runLog;
  clearOpencodeVersionCache();
});

afterEach(async () => {
  delete process.env.FAKE_OPENCODE_RUN_LOG;
  delete process.env.FAKE_OPENCODE_VERSION;
  for (const h of harnesses) {
    h.engine.killAll();
    void h.pool.stopAll();
  }
  for (const h of harnesses) await waitFor(() => h.pool.size() === 0).catch(() => {});
  harnesses = [];
});

const runs = () => (fs.existsSync(runLog) ? fs.readFileSync(runLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

describe("run mode", { timeout: 30_000 }, () => {
  it("1.x gets --variant for an effort the model lists, and nothing for one it does not", async () => {
    const { engine } = harness(FAKE, "run");
    await engine.run(runOpts(FAKE, { effortLevel: "xhigh" }));
    await engine.run(runOpts(FAKE, { model: "mock/one", effortLevel: "xhigh" }));
    await engine.run(runOpts(FAKE, { model: "mock/none", effortLevel: "high" }));
    await engine.run(runOpts(FAKE, { effortLevel: "default" }));
    const [listed, unlisted, none, unset] = runs();
    expect(listed!.slice(listed!.indexOf("-m"))).toEqual(["-m", "mock/five", "--variant", "xhigh"]);
    for (const argv of [unlisted!, none!, unset!]) expect(argv).not.toContain("--variant");
    expect(unlisted).toContain("mock/one");
  });

  it("2.x gets the variant on the model, read from the binary's version", async () => {
    process.env.FAKE_OPENCODE_VERSION = "v2:2.0.29";
    const { engine } = harness(FAKE, "run");
    await engine.run(runOpts(FAKE, { effortLevel: "high" }));
    await engine.run(runOpts(FAKE, { model: "mock/one", effortLevel: "low" }));
    const [withVariant, without] = runs();
    expect(withVariant).toContain("mock/five#high");
    expect(withVariant).not.toContain("--variant");
    expect(without).toContain("mock/one");
  });

  it("sends nothing when the engine has no registry to ask", async () => {
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { limits: () => ({}), bin: () => FAKE });
    const engine = new OpencodeEngine({ mode: () => "run", servers: pool });
    harnesses.push({ engine, pool });
    await engine.run(runOpts(FAKE, { effortLevel: "high" }));
    expect(runs()[0]).not.toContain("--variant");
  });
});

interface LogEntry { method: string; url?: string; path?: string; body?: Record<string, any> }

async function serverLog(pool: OpencodeServerPool, route: string): Promise<LogEntry[]> {
  const server = pool.get("sess-1")!;
  const res = await fetch(`${server.apiUrl}${route}`, { headers: { authorization: basicAuthHeader(server.password) } });
  const body = JSON.parse(await res.text());
  return Array.isArray(body) ? body : body.data;
}

describe("server mode, 1.x", { timeout: 30_000 }, () => {
  const promptBodies = async (pool: OpencodeServerPool) =>
    (await serverLog(pool, "/test/log")).filter((e) => e.url?.endsWith("/prompt_async")).map((e) => e.body!);

  it("sends the variant in the prompt body, per turn", async () => {
    const { engine, pool } = harness(FAKE, "server");
    const first = await engine.run(runOpts(FAKE, { effortLevel: "max" }));
    await engine.run(runOpts(FAKE, { resumeSessionId: first.sessionId, effortLevel: "low" }));
    await engine.run(runOpts(FAKE, { resumeSessionId: first.sessionId }));
    const [one, two, three] = await promptBodies(pool);
    expect(one).toMatchObject({ model: { providerID: "mock", modelID: "five" }, variant: "max" });
    expect(two!.variant).toBe("low");
    expect("variant" in three!).toBe(false);
  });

  it("sends none for an effort the model does not list, or a model that lists none", async () => {
    const { engine, pool } = harness(FAKE, "server");
    await engine.run(runOpts(FAKE, { model: "mock/one", effortLevel: "max" }));
    await engine.run(runOpts(FAKE, { model: "mock/none", effortLevel: "high" }));
    for (const body of await promptBodies(pool)) expect("variant" in body).toBe(false);
  });

  it("takes an explicit --variant from cliFlags without warning that it is ignored", async () => {
    const { engine, pool } = harness(FAKE, "server");
    await engine.run(runOpts(FAKE, { model: "mock/none", effortLevel: "high", cliFlags: ["--variant", "turbo"] }));
    expect((await promptBodies(pool))[0]!.variant).toBe("turbo");
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("ignores cliFlags"));
  });
});

describe("server mode, 2.x", { timeout: 30_000 }, () => {
  const creates = async (pool: OpencodeServerPool) => (await serverLog(pool, "/test/log")).filter((e) => e.method === "POST" && e.path === "/api/session");
  const selects = async (pool: OpencodeServerPool) => (await serverLog(pool, "/test/log")).filter((e) => e.path?.endsWith("/model")).map((e) => e.body);

  it("creates the session with the variant in the model ref, and none without one", async () => {
    const withEffort = harness(FAKE_V2, "server");
    await withEffort.engine.run(runOpts(FAKE_V2, { effortLevel: "high" }));
    expect((await creates(withEffort.pool))[0]!.body!.model).toEqual({ providerID: "mock", id: "five", variant: "high" });
    withEffort.engine.killAll();
    await withEffort.pool.stopAll();

    const without = harness(FAKE_V2, "server");
    await without.engine.run(runOpts(FAKE_V2, { model: "mock/none", effortLevel: "high" }));
    expect((await creates(without.pool))[0]!.body!.model).toEqual({ providerID: "mock", id: "none" });
  });

  it("re-posts the model on resume only when the variant changed, going to none included", async () => {
    const { engine, pool } = harness(FAKE_V2, "server");
    const first = await engine.run(runOpts(FAKE_V2, { effortLevel: "high" }));
    const resume = (over: Partial<EngineRunOpts>) => engine.run(runOpts(FAKE_V2, { resumeSessionId: first.sessionId, ...over }));

    await resume({ effortLevel: "high" });
    expect(await selects(pool)).toEqual([]);

    await resume({ effortLevel: "low" });
    expect(await selects(pool)).toEqual([{ model: { providerID: "mock", id: "five", variant: "low" } }]);

    await resume({ effortLevel: "low" });
    expect(await selects(pool)).toHaveLength(1);

    await resume({});
    expect((await selects(pool))[1]).toEqual({ model: { providerID: "mock", id: "five" } });

    // None again: the server reports it as "default", which is not a change.
    await resume({ effortLevel: "default" });
    expect(await selects(pool)).toHaveLength(2);

    // The model and the variant both changed: one post.
    await resume({ model: "mock/one", effortLevel: "high" });
    expect((await selects(pool))[2]).toEqual({ model: { providerID: "mock", id: "one", variant: "high" } });
    expect(await selects(pool)).toHaveLength(3);
  });

  it("keeps a variant off a model that lists none, on create and on resume", async () => {
    const { engine, pool } = harness(FAKE_V2, "server");
    const first = await engine.run(runOpts(FAKE_V2, { model: "mock/one", effortLevel: "xhigh" }));
    await engine.run(runOpts(FAKE_V2, { model: "mock/one", resumeSessionId: first.sessionId, effortLevel: "xhigh" }));
    expect(await selects(pool)).toEqual([]);
    expect((await creates(pool))[0]!.body!.model).toEqual({ providerID: "mock", id: "one" });
  });
});
