import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverOpencodeModels, withConfiguredWindows } from "../opencode-models.js";
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
    const models = await discoverOpencodeModels(fakeBin(REJECTS_VERBOSE));
    expect(models.map((m) => m.id)).toEqual(["opencode/alpha", "opencode/beta", "opencode/gamma"]);
    expect(models.every((m) => m.contextWindow === undefined)).toBe(true);
    expect(calls()).toEqual(["models --verbose", "models --standalone"]);
  });

  it("asks again without --standalone when the build rejects that flag too", async () => {
    const bin = fakeBin([
      'if [ "$2" = "--verbose" ] || [ "$2" = "--standalone" ]; then echo "unknown flag" >&2; exit 1; fi',
      "echo opencode/legacy",
    ].join("\n"));
    expect((await discoverOpencodeModels(bin)).map((m) => m.id)).toEqual(["opencode/legacy"]);
    expect(calls()).toEqual(["models --verbose", "models --standalone", "models"]);
  });

  it("falls back when --verbose exits 0 but prints no model", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then echo "nothing to show"; exit 0; fi\necho opencode/plain');
    expect((await discoverOpencodeModels(bin)).map((m) => m.id)).toEqual(["opencode/plain"]);
    expect(calls()).toEqual(["models --verbose", "models --standalone"]);
  });

  it("falls back when --verbose lists models but exits non-zero", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then echo opencode/partial; exit 3; fi\necho opencode/full-a; echo opencode/full-b');
    expect((await discoverOpencodeModels(bin)).map((m) => m.id)).toEqual(["opencode/full-a", "opencode/full-b"]);
  });

  it("keeps what --verbose printed when the plain run has nothing either", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then echo opencode/partial; exit 3; fi\nexit 1');
    expect((await discoverOpencodeModels(bin)).map((m) => m.id)).toEqual(["opencode/partial"]);
  });

  it("does not run the plain list when --verbose worked", async () => {
    const bin = fakeBin('if [ "$2" = "--verbose" ]; then printf "opencode/a\\n{\\n  \\"limit\\": { \\"context\\": 4096 }\\n}\\n"; else echo opencode/zzz; fi');
    const models = await discoverOpencodeModels(bin);
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["opencode/a", 4096]]);
    expect(calls()).toEqual(["models --verbose"]);
  });

  it("returns an empty catalogue when both runs fail", async () => {
    expect(await discoverOpencodeModels(fakeBin("echo boom >&2; exit 1"))).toEqual([]);
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
    const models = await discoverOpencodeModels(bin);
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["opencode/first", 64000], ["opencode/second", 8000]]);
  });

  it("does not take a model from stderr", async () => {
    const bin = fakeBin('echo "opencode/from-stderr" >&2\nexit 0');
    expect(await discoverOpencodeModels(bin)).toEqual([]);
  });
});

describe("discoverOpencodeModels environment", () => {
  // Records the variable on every run, then behaves like 2.x: `--verbose` is
  // rejected and the plain list needs `--standalone`, so three spawns are made.
  const RECORDS_ENV = [
    'echo "DISABLE_FFF=${OPENCODE_DISABLE_FFF-unset} GATEWAY_ONLY=${GATEWAY_ONLY-unset}" >> "$ENV_LOG"',
    'if [ "$2" = "--verbose" ]; then exit 1; fi',
    'if [ "$2" != "--standalone" ]; then exit 1; fi',
    "echo opencode/alpha",
  ].join("\n");

  it("starts every run with the env it is given, not the gateway's", async () => {
    vi.stubEnv("GATEWAY_ONLY", "leaked");
    const envLog = path.join(dir, "env.log");
    const bin = fakeBin(RECORDS_ENV);
    const models = await discoverOpencodeModels(bin, { PATH: process.env.PATH ?? "", ENV_LOG: envLog, OPENCODE_DISABLE_FFF: "1" });
    expect(models.map((m) => m.id)).toEqual(["opencode/alpha"]);
    expect(fs.readFileSync(envLog, "utf8").trim().split("\n")).toEqual(Array(2).fill("DISABLE_FFF=1 GATEWAY_ONLY=unset"));
    vi.unstubAllEnvs();
  });

  it("inherits the gateway's env when none is given", async () => {
    vi.stubEnv("ENV_LOG", path.join(dir, "env.log"));
    vi.stubEnv("GATEWAY_ONLY", "inherited");
    await discoverOpencodeModels(fakeBin(RECORDS_ENV));
    expect(fs.readFileSync(path.join(dir, "env.log"), "utf8").trim().split("\n")[0]).toBe("DISABLE_FFF=unset GATEWAY_ONLY=inherited");
    vi.unstubAllEnvs();
  });
});

describe("withConfiguredWindows", () => {
  const discovered = (): ModelInfo[] => [
    { id: "opencode/a", label: "a", supportsEffort: false, effortLevels: [], contextWindow: 200_000 },
    { id: "opencode/b", label: "b", supportsEffort: false, effortLevels: [] },
  ];
  const block = (...windows: Array<[string, number]>): EngineModelsConfig =>
    ({ models: windows.map(([id, contextWindow]) => ({ id, label: id, contextWindow })) }) as unknown as EngineModelsConfig;

  it("applies a positive configured window", () => {
    const out = withConfiguredWindows(discovered(), block(["opencode/a", 128_000], ["opencode/b", 32_000]));
    expect(out.map((m) => m.contextWindow)).toEqual([128_000, 32_000]);
  });

  it("ignores a window of 0, a negative one, NaN or Infinity, keeping the discovered one", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = withConfiguredWindows(discovered(), block(["opencode/a", bad], ["opencode/b", bad]));
      expect(out.map((m) => m.contextWindow)).toEqual([200_000, undefined]);
    }
  });
});
