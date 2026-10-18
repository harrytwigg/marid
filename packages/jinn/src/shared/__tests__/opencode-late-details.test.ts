import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Employee, JinnConfig, ModelInfo } from "../types.js";
import type { OpencodeDiscovery } from "../opencode-discovery.js";

/**
 * The registry and effort validation while opencode's `--verbose` details are
 * still to come: a slow first run behind the plain list, and the second look a
 * first detailed answer gets. Discovery itself is stood in for, so each test
 * decides what each run answers and when.
 */
type Answer = () => OpencodeDiscovery | Promise<OpencodeDiscovery>;
const discoveries: Answer[] = [];
/** What a run answers once the test's own answers are used up: nothing. */
const NOTHING: Answer = () => ({ models: [], detailed: false });
vi.mock("../opencode-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../opencode-discovery.js")>()),
  discoverOpencodeModels: vi.fn(async () => (discoveries.shift() ?? NOTHING)()),
}));

const { discoverOpencodeModels } = await import("../opencode-discovery.js");
const { buildRegistry, effortLevelsForModel, refreshOpencodeModels } = await import("../models.js");
const { effortLevelsPending, effortLevelsSettled, onLateOpencodeDetails } = await import("../opencode-catalogue.js");
const { validateNewSessionSelection, validateSessionPatch } = await import("../../sessions/session-patch.js");
const { validateEmployeeUpdate } = await import("../../gateway/org.js");
const { awaitEffortLevels } = await import("../effort-wait.js");

let dir: string;
let config: JinnConfig;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-late-details-"));
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  config = { gateway: {}, engines: { default: "claude", opencode: { bin } }, sessions: {} } as unknown as JinnConfig;
});

afterEach(async () => {
  // Back to no catalogue and nothing pending, for the next test and the next file.
  await refreshOpencodeModels({ ...config, engines: { default: "claude", opencode: { bin: path.join(dir, "missing") } } } as unknown as JinnConfig);
  discoveries.length = 0;
  vi.mocked(discoverOpencodeModels).mockClear();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const plain = (): ModelInfo[] => [{ id: "opencode/a", label: "a", supportsEffort: false, effortLevels: [] }];
const detailed = (levels = ["low", "high"]): ModelInfo[] => [{ id: "opencode/a", label: "a", supportsEffort: true, effortLevels: levels, contextWindow: 200_000 }];
const answer = (models: ModelInfo[]): Answer => () => ({ models, detailed: true });

/** Let every promise already settled run its callbacks. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** An answer the test releases itself. */
function deferred<T>(): { promise: Promise<T>; release: (value: T) => Promise<void> } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, release: async (value) => { resolve(value); await flush(); } };
}

/** A run that outlives the discovery timeout: the plain list now, details on `land`. */
function slowDetails() {
  const details = deferred<ModelInfo[] | undefined>();
  return {
    discovery: (): OpencodeDiscovery => ({ models: plain(), detailed: false, details: details.promise }),
    land: details.release,
  };
}

const entry = () => buildRegistry(config).opencode.models.find((m) => m.id === "opencode/a");

describe("a --verbose run that outlives the discovery timeout", () => {
  it("serves the plain list, then swaps in the windows and levels when the run finishes, and says so", async () => {
    const slow = slowDetails();
    discoveries.push(slow.discovery);
    const late = vi.fn();
    const stop = onLateOpencodeDetails(late);
    try {
      await refreshOpencodeModels(config);
      expect(entry()).toMatchObject({ supportsEffort: false, effortLevels: [] });
      expect(entry()?.contextWindow).toBeUndefined();
      expect(effortLevelsPending("opencode")).toBe(true);

      await slow.land(detailed());
      expect(entry()).toMatchObject({ supportsEffort: true, effortLevels: ["low", "high"], contextWindow: 200_000 });
      expect(effortLevelsPending("opencode")).toBe(false);
      expect(late).toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("stops being pending and keeps the plain list when the run fails", async () => {
    const slow = slowDetails();
    discoveries.push(slow.discovery);
    await refreshOpencodeModels(config);
    await slow.land(undefined);
    expect(effortLevelsPending("opencode")).toBe(false);
    expect(entry()).toMatchObject({ supportsEffort: false, effortLevels: [] });
  });

  it("does not put a plain list over a detailed catalogue, nor go pending, on a later slow refresh", async () => {
    discoveries.push(answer(detailed()));
    await refreshOpencodeModels(config);
    await flush();
    const slow = slowDetails();
    discoveries.push(slow.discovery);
    await refreshOpencodeModels(config);
    expect(effortLevelsPending("opencode")).toBe(false);
    expect(entry()).toMatchObject({ effortLevels: ["low", "high"] });
    await slow.land(undefined);
    expect(entry()).toMatchObject({ effortLevels: ["low", "high"] });
  });

  it("drops details a newer refresh has overtaken", async () => {
    const slow = slowDetails();
    discoveries.push(slow.discovery);
    await refreshOpencodeModels(config);
    discoveries.push(answer(detailed(["max"])));
    await refreshOpencodeModels(config);
    await flush();
    expect(effortLevelsPending("opencode")).toBe(false);
    await slow.land(detailed());
    expect(entry()).toMatchObject({ effortLevels: ["max"] });
  });
});

describe("an overtaken refresh", () => {
  it("still lands details the snapshot lacks, so a newer refresh that fails cannot bring the refusal back", async () => {
    // A boot refresh and a config reload during its first minute are both slow.
    const boot = slowDetails();
    const reload = slowDetails();
    discoveries.push(boot.discovery, reload.discovery);
    await refreshOpencodeModels(config);
    await refreshOpencodeModels(config);
    await boot.land(detailed());
    expect(entry()).toMatchObject({ effortLevels: ["low", "high"] });
    expect(effortLevelsPending("opencode")).toBe(false);
    await reload.land(undefined);
    expect(entry()).toMatchObject({ effortLevels: ["low", "high"] });
    expect(validateNewSessionSelection(config, { engine: "opencode", model: "opencode/a", effortLevel: "high" })).toMatchObject({ ok: true, effortLevel: "high" });
  });
});

describe("the gateway's second look at a first detailed answer", () => {
  const gateway = { secondLook: true };

  it("serves the first answer at once, then takes the second run's catalogue", async () => {
    // A fresh home's first run lists the catalogue bundled in the binary; the next one the current catalogue.
    const second = deferred<OpencodeDiscovery>();
    discoveries.push(answer(detailed(["high"])), () => second.promise);
    await refreshOpencodeModels(config, gateway);
    expect(entry()).toMatchObject({ effortLevels: ["high"] });
    await second.release({ models: [...detailed(["low", "medium", "high"]), { ...detailed()[0], id: "opencode/new" }], detailed: true });
    expect(entry()).toMatchObject({ effortLevels: ["low", "medium", "high"] });
    expect(effortLevelsPending("opencode", "opencode/new")).toBe(false);
  });

  it("leaves a model the first answer lists alone while it runs, and holds one it does not", async () => {
    const second = deferred<OpencodeDiscovery>();
    discoveries.push(answer(detailed()), () => second.promise);
    await refreshOpencodeModels(config, gateway);
    expect(effortLevelsPending("opencode", "opencode/a")).toBe(false);
    expect(effortLevelsPending("opencode", "opencode/new")).toBe(true);
    expect(effortLevelsPending("opencode")).toBe(true);
    await second.release({ models: detailed(), detailed: true });
    expect(effortLevelsPending("opencode", "opencode/new")).toBe(false);
  });

  it("keeps the first answer when the second run finds nothing", async () => {
    discoveries.push(answer(detailed(["high"])));
    await refreshOpencodeModels(config, gateway);
    await flush();
    expect(effortLevelsPending("opencode", "opencode/new")).toBe(false);
    expect(entry()).toMatchObject({ effortLevels: ["high"] });
  });

  it("is taken once: a later refresh over the detailed catalogue runs discovery once", async () => {
    discoveries.push(answer(detailed()), answer(detailed()));
    await refreshOpencodeModels(config, gateway);
    await flush();
    expect(discoverOpencodeModels).toHaveBeenCalledTimes(2);
    discoveries.push(answer(detailed(["max"])));
    await refreshOpencodeModels(config, gateway);
    await flush();
    expect(discoverOpencodeModels).toHaveBeenCalledTimes(3);
    expect(entry()).toMatchObject({ effortLevels: ["max"] });
  });

  it("is not taken outside the gateway: a CLI command runs discovery once and is not left waiting", async () => {
    discoveries.push(answer(detailed()));
    await refreshOpencodeModels(config);
    await flush();
    expect(discoverOpencodeModels).toHaveBeenCalledTimes(1);
    expect(effortLevelsPending("opencode")).toBe(false);
  });
});

describe("effort while the levels are pending", () => {
  async function pendingWindow() {
    const slow = slowDetails();
    discoveries.push(slow.discovery);
    await refreshOpencodeModels(config);
    return slow;
  }

  it("accepts a chosen effort on a new session and on a patch instead of refusing it", async () => {
    await pendingWindow();
    expect(validateNewSessionSelection(config, { engine: "opencode", model: "opencode/a", effortLevel: "high" })).toMatchObject({ ok: true, effortLevel: "high" });
    expect(validateSessionPatch(config, "opencode", "opencode/a", { effortLevel: "high" })).toMatchObject({ ok: true, updates: { effortLevel: "high" } });
  });

  it("keeps an employee's default effort on a new session instead of dropping it", async () => {
    await pendingWindow();
    const result = validateNewSessionSelection(config, { engine: "opencode" }, { model: "opencode/a", effortLevel: "high" });
    expect(result).toMatchObject({ ok: true, effortLevel: "high" });
  });

  it("accepts an employee's effort and keeps the one it has across a model change", async () => {
    await pendingWindow();
    const current = { name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "opencode", model: "opencode/a", persona: "", effortLevel: "high" } as Employee;
    expect(validateEmployeeUpdate(config, current, { effortLevel: "low" })).toMatchObject({ ok: true, updates: { effortLevel: "low" } });
    const moved = validateEmployeeUpdate(config, current, { model: "opencode/b" });
    expect(moved.ok).toBe(true);
    expect(moved.updates).not.toHaveProperty("effortLevel");
  });

  it("refuses again once the levels are known", async () => {
    const slow = await pendingWindow();
    await slow.land(detailed());
    expect(effortLevelsPending("opencode")).toBe(false);
    expect(validateNewSessionSelection(config, { engine: "opencode", model: "opencode/a", effortLevel: "max" })).toMatchObject({ ok: false });
  });

  it("holds a turn with an effort until the levels land, so it resolves against them", async () => {
    const slow = await pendingWindow();
    let resolved: string[] | undefined;
    const turn = awaitEffortLevels(config, "opencode", { parentSessionId: null, effortLevel: "high" }, null)
      .then(() => (resolved = effortLevelsForModel(config, "opencode", "opencode/a")));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBeUndefined();
    await slow.land(detailed());
    await turn;
    expect(resolved).toEqual(["low", "high"]);
  });

  it("does not hold a turn that has no effort to resolve", async () => {
    await pendingWindow();
    let done = false;
    await Promise.race([
      awaitEffortLevels(config, "opencode", { parentSessionId: null, effortLevel: null }, null).then(() => (done = true)),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(done).toBe(true);
  });

  it("gives up waiting at the bound", async () => {
    await pendingWindow();
    const start = Date.now();
    await effortLevelsSettled("opencode", 30);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(effortLevelsPending("opencode")).toBe(true);
  });

  it("concerns opencode only", async () => {
    await pendingWindow();
    expect(effortLevelsPending("claude")).toBe(false);
  });
});
