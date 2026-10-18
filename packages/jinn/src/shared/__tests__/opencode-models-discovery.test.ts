import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withConfiguredOverrides } from "../opencode-models.js";
import { discoverOpencodeModels } from "../opencode-discovery.js";
import type { EngineModelsConfig, ModelInfo } from "../types.js";

/**
 * `discoverOpencodeModels` against stand-in binaries: the builds that reject
 * `--verbose` (OpenCode 2.x), and a stderr that shares a run with the records.
 */
let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-discovery-"));
  log = path.join(dir, "calls.log");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A binary that records its arguments, then runs `body` (a sh script). */
function fakeBin(body: string): string {
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  return bin;
}

const calls = (): string[] => fs.readFileSync(log, "utf8").trim().split("\n");

describe("discoverOpencodeModels without --verbose support", () => {
  // What 2.0.29 does: `models --verbose` exits 1 with no model on stdout, and
  // plain `models` needs `--standalone` (it otherwise wants its background service).
  const REJECTS_VERBOSE = [
    'if [ "$2" = "--verbose" ]; then echo "Unrecognized flag: --verbose in command opencode models" >&2; exit 1; fi',
    'if [ "$2" != "--standalone" ]; then echo "Error: Server process exited with code 1" >&2; exit 1; fi',
    "printf 'opencode/alpha\\nopencode/beta\\nopencode/gamma\\n'",
  ].join("\n");

  it("falls back to the plain list, whose entries carry no windows", async () => {
    const models = (await discoverOpencodeModels(fakeBin(REJECTS_VERBOSE))).models;
    expect(models.map((m) => m.id)).toEqual(["opencode/alpha", "opencode/beta", "opencode/gamma"]);
    expect(models.every((m) => m.contextWindow === undefined)).toBe(true);
    expect(calls()).toEqual(["models --verbose", "api model.list --standalone", "models --standalone"]);
  });

  it("asks again without --standalone when the build rejects that flag too", async () => {
    const bin = fakeBin([
      'if [ "$2" = "--verbose" ] || [ "$2" = "--standalone" ]; then echo "unknown flag" >&2; exit 1; fi',
      "echo opencode/legacy",
    ].join("\n"));
    expect((await discoverOpencodeModels(bin)).models.map((m) => m.id)).toEqual(["opencode/legacy"]);
    expect(calls()).toEqual(["models --verbose", "api model.list --standalone", "models --standalone", "models"]);
  });

  it("falls back when --verbose exits 0 but prints no model", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then echo "nothing to show"; exit 0; fi\necho opencode/plain');
    expect((await discoverOpencodeModels(bin)).models.map((m) => m.id)).toEqual(["opencode/plain"]);
    expect(calls()).toEqual(["models --verbose", "api model.list --standalone", "models --standalone"]);
  });

  it("falls back when --verbose lists models but exits non-zero", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then echo opencode/partial; exit 3; fi\necho opencode/full-a; echo opencode/full-b');
    expect((await discoverOpencodeModels(bin)).models.map((m) => m.id)).toEqual(["opencode/full-a", "opencode/full-b"]);
  });

  it("keeps what --verbose printed when the plain run has nothing either", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then echo opencode/partial; exit 3; fi\nexit 1');
    expect((await discoverOpencodeModels(bin)).models.map((m) => m.id)).toEqual(["opencode/partial"]);
  });

  it("does not run the plain list when --verbose worked", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then printf "opencode/a\\n{\\n  \\"limit\\": { \\"context\\": 4096 }\\n}\\n"; else echo opencode/zzz; fi');
    const models = (await discoverOpencodeModels(bin)).models;
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["opencode/a", 4096]]);
    expect(calls()).toEqual(["models --verbose"]);
  });

  it("returns an empty catalogue when both runs fail", async () => {
    expect((await discoverOpencodeModels(fakeBin("echo boom >&2; exit 1"))).models).toEqual([]);
  });
});

describe("discoverOpencodeModels with a slow --verbose", () => {
  // A fresh opencode home bootstraps before it lists anything: the first
  // `--verbose` can run far past the discovery timeout while the plain list is quick.
  const SLOW_VERBOSE = (seconds: number) => [
    `if [ "$2" = "--verbose" ]; then sleep ${seconds}; printf 'opencode/a\\n{\\n  "limit": { "context": 4096 },\\n  "variants": { "high": {} }\\n}\\n'; exit 0; fi`,
    "echo opencode/a",
  ].join("\n");

  it("serves the plain list at the timeout and hands over the verbose catalogue when that same run finishes", async () => {
    const discovery = await discoverOpencodeModels(fakeBin(SLOW_VERBOSE(1)), { timeoutMs: 200, detailsTimeoutMs: 10_000 });
    expect(discovery.detailed).toBe(false);
    expect(discovery.models.map((m) => [m.id, m.contextWindow, m.effortLevels])).toEqual([["opencode/a", undefined, []]]);
    const details = await discovery.details;
    expect(details?.map((m) => [m.id, m.contextWindow, m.effortLevels])).toEqual([["opencode/a", 4096, ["high"]]]);
    // One --verbose run, not a retry: the slow one was left to finish.
    expect(calls()).toEqual(["models --verbose", "api model.list --standalone", "models --standalone"]);
  });

  it("hands over nothing when the run outlives the details timeout too", async () => {
    const discovery = await discoverOpencodeModels(fakeBin(SLOW_VERBOSE(5)), { timeoutMs: 100, detailsTimeoutMs: 400 });
    expect(discovery.models.map((m) => m.id)).toEqual(["opencode/a"]);
    expect(await discovery.details).toBeUndefined();
  });

  it("has no details to wait for when the API answered with records meanwhile", async () => {
    const api = path.join(__dirname, "fixtures", "opencode-api-model-list.json");
    const bin = fakeBin([
      'if [ "$2" = "--verbose" ]; then sleep 5; exit 1; fi',
      `if [ "$1 $2 $3" = "api model.list --standalone" ]; then cat "${api}"; exit 0; fi`,
      "echo opencode/plain",
    ].join("\n"));
    const discovery = await discoverOpencodeModels(bin, { timeoutMs: 100, detailsTimeoutMs: 400 });
    expect(discovery.detailed).toBe(true);
    expect(discovery.details).toBeUndefined();
    expect(discovery.models.some((m) => m.contextWindow !== undefined)).toBe(true);
  });

  it("has no details to wait for when --verbose finished in time", async () => {
    const discovery = await discoverOpencodeModels(fakeBin(SLOW_VERBOSE(0)), { timeoutMs: 5_000 });
    expect(discovery.detailed).toBe(true);
    expect(discovery.details).toBeUndefined();
    expect(calls()).toEqual(["models --verbose"]);
  });
});

describe("discoverOpencodeModels on OpenCode 2.x", () => {
  const API_LIST = path.join(__dirname, "fixtures", "opencode-api-model-list.json");
  // 2.0.29: no `--verbose`, and the records come from `api model.list --standalone`.
  const v2 = (api: string) => fakeBin([
    'if [ "$2" = "--verbose" ]; then echo "Unrecognized flag: --verbose in command opencode models" >&2; exit 1; fi',
    `if [ "$1 $2 $3" = "api model.list --standalone" ]; then ${api}; fi`,
    "printf 'opencode/alpha\\nopencode/beta\\n'",
  ].join("\n"));

  it("takes windows and variants from the server API, and runs no plain list", async () => {
    const models = (await discoverOpencodeModels(v2(`cat "${API_LIST}"; exit 0`))).models;
    expect(models.map((m) => [m.id, m.supportsEffort ? m.effortLevels : null, m.contextWindow])).toEqual([
      ["opencode/big-pickle", null, 200000],
      ["opencode/deepseek-v4.1-flash-free", ["low", "high", "max"], 200000],
      ["opencode/space-bunny-free", ["low", "medium", "high", "xhigh", "max"], 1048576],
    ]);
    expect(calls()).toEqual(["models --verbose", "api model.list --standalone"]);
  });

  it("falls back to the plain list when the API run fails", async () => {
    expect((await discoverOpencodeModels(v2(`cat "${API_LIST}"; exit 1`))).models.map((m) => m.id)).toEqual(["opencode/alpha", "opencode/beta"]);
    expect(calls()).toEqual(["models --verbose", "api model.list --standalone", "models --standalone"]);
  });

  it("falls back to the plain list when the API answers with something else", async () => {
    for (const answer of ['echo "not json"; exit 0', `echo '{"data":[]}'; exit 0`]) {
      fs.rmSync(log, { force: true });
      const models = (await discoverOpencodeModels(v2(answer))).models;
      expect(models.map((m) => [m.id, m.supportsEffort])).toEqual([["opencode/alpha", false], ["opencode/beta", false]]);
    }
  });
});

describe("discoverOpencodeModels reads stdout only", () => {
  it("keeps a model's window when stderr writes between the lines of its record", async () => {
    const bin = fakeBin([
      "echo opencode/first",
      "echo '{'",
      "echo 'warning: slow provider lookup' >&2",
      "echo '  \"limit\": { \"context\": 64000 }'",
      "echo '}'",
      "echo opencode/second",
      "echo '{'",
      "echo '  \"limit\": { \"context\": 8000 }'",
      "echo 'opencode/not-a-model-from-stderr' >&2",
      "echo '}'",
    ].join("\n"));
    const models = (await discoverOpencodeModels(bin)).models;
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["opencode/first", 64000], ["opencode/second", 8000]]);
  });

  it("does not take a model from stderr", async () => {
    const bin = fakeBin('echo "opencode/from-stderr" >&2\nexit 0');
    expect((await discoverOpencodeModels(bin)).models).toEqual([]);
  });
});

describe("withConfiguredOverrides", () => {
  const discovered = (): ModelInfo[] => [
    { id: "opencode/a", label: "a", supportsEffort: false, effortLevels: [], contextWindow: 200_000 },
    { id: "opencode/b", label: "b", supportsEffort: false, effortLevels: [] },
  ];
  const block = (...windows: Array<[string, number]>): EngineModelsConfig =>
    ({ models: windows.map(([id, contextWindow]) => ({ id, label: id, contextWindow })) }) as unknown as EngineModelsConfig;

  it("applies a positive configured window", () => {
    const out = withConfiguredOverrides(discovered(), block(["opencode/a", 128_000], ["opencode/b", 32_000]));
    expect(out.map((m) => m.contextWindow)).toEqual([128_000, 32_000]);
  });

  it("ignores a window of 0, a negative one, NaN or Infinity, keeping the discovered one", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = withConfiguredOverrides(discovered(), block(["opencode/a", bad], ["opencode/b", bad]));
      expect(out.map((m) => m.contextWindow)).toEqual([200_000, undefined]);
    }
  });
});

describe("withConfiguredOverrides effort levels", () => {
  const discovered = (): ModelInfo[] => [
    { id: "opencode/a", label: "a", supportsEffort: true, effortLevels: ["high"] },
    { id: "opencode/b", label: "b", supportsEffort: false, effortLevels: [] },
  ];
  const entries = (...models: Array<Record<string, unknown>>): EngineModelsConfig => ({ models }) as unknown as EngineModelsConfig;

  it("lets a configured list win over the discovered one, and with supportsEffort: true give a model without any its own", () => {
    const out = withConfiguredOverrides(discovered(), entries(
      { id: "opencode/a", effortLevels: ["low", "high"] },
      { id: "opencode/b", supportsEffort: true, effortLevels: ["medium"], contextWindow: 9000 },
    ));
    expect(out).toEqual([
      { id: "opencode/a", label: "a", supportsEffort: true, effortLevels: ["low", "high"] },
      { id: "opencode/b", label: "b", supportsEffort: true, effortLevels: ["medium"], contextWindow: 9000 },
    ]);
  });

  it("does not turn effort on for a model without it from a list alone, as a block with no discovery does not", () => {
    const out = withConfiguredOverrides(discovered(), entries({ id: "opencode/b", effortLevels: ["medium"], contextWindow: 9000 }));
    expect(out[1]).toEqual({ id: "opencode/b", label: "b", supportsEffort: false, effortLevels: [], contextWindow: 9000 });
  });

  it("keeps the discovered levels when the configured list names none", () => {
    for (const effortLevels of [[], [""], undefined, "high"]) {
      expect(withConfiguredOverrides(discovered(), entries({ id: "opencode/a", effortLevels }))).toEqual(discovered());
    }
  });

  it("switches effort off for a model configured with supportsEffort: false", () => {
    const out = withConfiguredOverrides(discovered(), entries({ id: "opencode/a", supportsEffort: false, effortLevels: ["low"] }));
    expect(out[0]).toEqual({ id: "opencode/a", label: "a", supportsEffort: false, effortLevels: [] });
  });

  it("does not add a model the discovery did not list", () => {
    expect(withConfiguredOverrides(discovered(), entries({ id: "opencode/c", effortLevels: ["high"] }))).toEqual(discovered());
  });
});
