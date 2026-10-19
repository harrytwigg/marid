import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IONICE_CLASS,
  LOW_PRIORITY_ENV,
  NICE_LEVEL,
  exitCodeFor,
  findExecutable,
  lowPriorityEnabled,
  lowPrioritySpawnSpec,
  spawnLowPriority,
} from "../low-priority.mjs";
import { turboArgs } from "../run-package-tests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../low-priority.mjs");
const noNice = process.platform === "win32" ? "no nice(1) on Windows" : false;

/**
 * The ambient environment minus the three switches this module reads, so a test
 * run that is itself wrapped (`pnpm test`) or already inside CI cannot decide
 * what the test sees. `overrides` are applied back on top.
 */
function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ["CI", "JINN_TEST_NICE", LOW_PRIORITY_ENV]) {
    if (!(key in overrides)) delete env[key];
  }
  return env;
}

/**
 * Runs the wrapper CLI and returns spawnSync's result.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {import("node:child_process").StdioOptions} [stdio]
 */
function runWrapper(args, env, stdio = "ignore") {
  return spawnSync(process.execPath, [scriptPath, ...args], { env, stdio });
}

test("the low-priority path is on locally and off for CI, JINN_TEST_NICE=0 and Windows", () => {
  assert.equal(lowPriorityEnabled({ env: {}, platform: "linux" }), true);
  assert.equal(lowPriorityEnabled({ env: {}, platform: "darwin" }), true);
  assert.equal(lowPriorityEnabled({ env: { CI: "true" }, platform: "linux" }), false);
  assert.equal(lowPriorityEnabled({ env: { JINN_TEST_NICE: "0" }, platform: "linux" }), false);
  assert.equal(lowPriorityEnabled({ env: {}, platform: "win32" }), false);
});

test("the wrapper is nice(1) plus ionice(1) where ionice exists, and nice alone where it does not", () => {
  assert.deepEqual(lowPrioritySpawnSpec(["node", "x.mjs"], { platform: "linux", hasIonice: true }), {
    command: "nice",
    args: ["-n", String(NICE_LEVEL), "ionice", "-c", String(IONICE_CLASS), "node", "x.mjs"],
  });
  assert.deepEqual(lowPrioritySpawnSpec(["node", "x.mjs"], { platform: "darwin" }), {
    command: "nice",
    args: ["-n", String(NICE_LEVEL), "node", "x.mjs"],
  });
  assert.deepEqual(lowPrioritySpawnSpec(["node", "x.mjs"], { platform: "win32" }), {
    command: "node",
    args: ["x.mjs"],
  });
});

test("findExecutable finds a file on PATH and ignores one that is not there", { skip: noNice }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "low-priority-path-"));
  const binary = path.join(dir, "marker-tool");
  fs.writeFileSync(binary, "#!/bin/sh\n");
  fs.chmodSync(binary, 0o755);

  assert.equal(findExecutable("marker-tool", { env: { PATH: dir }, platform: "linux" }), binary);
  assert.equal(findExecutable("marker-tool", { env: { PATH: os.tmpdir() }, platform: "linux" }), null);
});

test("CI and JINN_TEST_NICE=0 run the command unchanged, with no low-priority marker", () => {
  for (const env of [cleanEnv({ CI: "true" }), cleanEnv({ JINN_TEST_NICE: "0" })]) {
    const result = spawnLowPriority(
      [process.execPath, "-p", `process.env[${JSON.stringify(LOW_PRIORITY_ENV)}] ?? "unset"`],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString().trim(), "unset");
  }
});

test("the local path marks the child so the suites can widen their timeouts", () => {
  const result = spawnLowPriority(
    [process.execPath, "-p", `process.env[${JSON.stringify(LOW_PRIORITY_ENV)}] ?? "unset"`],
    { env: cleanEnv(), stdio: ["ignore", "pipe", "inherit"] },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString().trim(), "1");
});

test("the local path really runs the command at nice 19", { skip: noNice }, () => {
  const result = spawnLowPriority([process.execPath, "-p", "require('node:os').getPriority()"], {
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString().trim(), String(NICE_LEVEL));
});

test("the wrapper propagates the exit code down every path", () => {
  const envs = [cleanEnv(), cleanEnv({ CI: "true" }), cleanEnv({ JINN_TEST_NICE: "0" })];
  for (const env of envs) {
    assert.equal(runWrapper([process.execPath, "-e", "process.exit(7)"], env).status, 7);
  }
  assert.equal(runWrapper([process.execPath, "-e", "process.exit(0)"], cleanEnv()).status, 0);
});

test("the wrapper propagates a signal as 128+n", { skip: noNice }, () => {
  const result = runWrapper([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], cleanEnv());
  assert.equal(result.status, 143);
});

test("with no command the wrapper says how to use it", () => {
  assert.equal(runWrapper([], cleanEnv()).status, 2);
});

test("the turbo runner keeps turbo serial in CI and lets it find its own concurrency locally", () => {
  assert.deepEqual(turboArgs({ env: { CI: "true" } }), ["run", "test", "--concurrency=1"]);
  assert.deepEqual(turboArgs({ env: {} }), ["run", "test"]);
});

test("exitCodeFor reads the code, and translates a signal", () => {
  assert.equal(exitCodeFor({ status: 3, signal: null }), 3);
  assert.equal(exitCodeFor({ status: 0, signal: null }), 0);
  assert.equal(exitCodeFor({ status: null, signal: "SIGTERM" }), 128 + os.constants.signals.SIGTERM);
  assert.equal(exitCodeFor({ status: null, signal: null }), 1);
});
