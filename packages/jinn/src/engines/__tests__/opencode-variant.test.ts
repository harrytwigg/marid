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
