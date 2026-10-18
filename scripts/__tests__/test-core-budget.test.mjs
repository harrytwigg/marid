import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RUN_CORES,
  MIN_GRANT,
  MIN_POOL,
  RESERVED_CORES,
  coreBudget,
  grantFor,
  liveLeases,
  poolSize,
  tryAcquireCores,
} from "../test-core-budget.mjs";

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-core-budget.mjs");

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "core-budget-test-"));
}

const budget = { global: 12, perRun: 8 };

test("the pool is the machine's cores minus the reserve, floored at the minimum", () => {
  assert.equal(RESERVED_CORES, 12);
  assert.equal(poolSize(64), 52);
  assert.equal(poolSize(32), 20);
  assert.equal(poolSize(24), 12);
  // Below the floor the minimum is enforced...
  assert.equal(poolSize(20), MIN_POOL);
  assert.equal(poolSize(16), MIN_POOL);
  // ...but never past what the machine actually has.
  assert.equal(poolSize(4), 4);
});

test("coreBudget: defaults, overrides, junk, and the CI and disabled no-ops", () => {
  assert.deepEqual(coreBudget({}, 64), { global: 52, perRun: DEFAULT_RUN_CORES });
  assert.deepEqual(coreBudget({}, 16), { global: 8, perRun: 8 });
  assert.deepEqual(coreBudget({ JINN_TEST_GLOBAL_CORES: "20" }, 64), { global: 20, perRun: 8 });
  assert.deepEqual(coreBudget({ JINN_TEST_GLOBAL_CORES: "200" }, 64), { global: 64, perRun: 8 });
  assert.deepEqual(coreBudget({ JINN_TEST_RESERVED_CORES: "4" }, 64), { global: 60, perRun: 8 });
  assert.deepEqual(coreBudget({ JINN_TEST_RUN_CORES: "4" }, 64), { global: 52, perRun: 4 });
  assert.deepEqual(coreBudget({ JINN_TEST_GLOBAL_CORES: "6" }, 64), { global: 6, perRun: 6 });
  assert.deepEqual(coreBudget({ JINN_TEST_GLOBAL_CORES: "off", JINN_TEST_RUN_CORES: "-3" }, 64), {
    global: 52,
    perRun: 8,
  });
  assert.deepEqual(coreBudget({ JINN_TEST_GLOBAL_CORES: "0" }, 64), { global: 0, perRun: 0 });
  assert.deepEqual(coreBudget({ CI: "true" }, 64), { global: 0, perRun: 0 });
});

test("grantFor takes what is free up to the per-run ceiling, and waits below the minimum", () => {
  assert.equal(grantFor({ free: 52, perRun: 8, global: 52 }), 8);
  assert.equal(grantFor({ free: 5, perRun: 8, global: 12 }), 5);
  assert.equal(grantFor({ free: MIN_GRANT, perRun: 8, global: 12 }), MIN_GRANT);
  assert.equal(grantFor({ free: MIN_GRANT - 1, perRun: 8, global: 12 }), 0);
  assert.equal(grantFor({ free: 0, perRun: 8, global: 12 }), 0);
  // A pool smaller than the minimum grant can still be leased whole.
  assert.equal(grantFor({ free: 1, perRun: 1, global: 1 }), 1);
});

test("leases share the pool: 8, then the remaining 4, then the machine is full", () => {
  const dir = freshDir();
  const first = tryAcquireCores({ dir, budget, pid: process.pid });
  const second = tryAcquireCores({ dir, budget, pid: process.pid });
  assert.equal(first.cores, 8);
  assert.equal(second.cores, 4);
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }), null);

  // A finished run gives its cores back.
  fs.rmSync(first.leasePath);
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }).cores, 8);
});

test("a lease whose owner is dead is reclaimed instead of holding cores forever", () => {
  const dir = freshDir();
  // 2^30 is far past any real pid table; process.kill reports it dead.
  fs.writeFileSync(path.join(dir, "lease-dead"), JSON.stringify({ pid: 2 ** 30, cores: 12 }));
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }).cores, 8);
  assert.equal(fs.existsSync(path.join(dir, "lease-dead")), false);
});

test("a live owner's lease is counted and not stolen", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "lease-live"), JSON.stringify({ pid: process.pid, cores: 12 }));
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }), null);
  assert.equal(liveLeases(dir).length, 1);
});

test("an ancient lease is stale even when its pid is alive (pid reuse)", () => {
  const dir = freshDir();
  const leasePath = path.join(dir, "lease-old");
  fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, cores: 12 }));
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(leasePath, fourHoursAgo, fourHoursAgo);
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }).cores, 8);
});

test("an unreadable lease file is reclaimed, not trusted", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "lease-junk"), "not json");
  fs.writeFileSync(path.join(dir, "lease-zero"), JSON.stringify({ pid: process.pid, cores: 0 }));
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }).cores, 8);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith("lease-")).length,
    1,
  );
});

test("a lock left behind by a dead run is broken, not waited on forever", () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, "lock"));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "lock"), old, old);
  assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }).cores, 8);
});

test("two processes share one pool: the child's lease is visible to the parent", async () => {
  const dir = freshDir();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireTestCores } from ${JSON.stringify(modulePath)};
       const { cores } = acquireTestCores({ dir: ${JSON.stringify(dir)}, budget: { global: 12, perRun: 8 }, log() {} });
       console.log("LEASED " + cores);
       process.stdin.resume();
       process.stdin.on("end", () => process.exit(0));`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => String(chunk).includes("LEASED 8") && resolve());
      child.on("exit", (code) => reject(new Error(`child exited ${code} before leasing`)));
    });
    assert.equal(tryAcquireCores({ dir, budget, pid: process.pid }).cores, 4);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
  }
  // The child released on exit, so the whole pool is free again.
  assert.equal(liveLeases(dir).filter((lease) => lease.pid === child.pid).length, 0);
});

test("a run that finds the pool empty blocks until cores free up, rather than failing", async () => {
  const dir = freshDir();
  const holder = tryAcquireCores({ dir, budget, pid: process.pid });
  const second = tryAcquireCores({ dir, budget, pid: process.pid });
  assert.equal(holder.cores + second.cores, 12);

  const waiter = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireTestCores } from ${JSON.stringify(modulePath)};
       const { cores } = acquireTestCores({ dir: ${JSON.stringify(dir)}, budget: { global: 12, perRun: 8 }, log: (m) => console.log("WAIT") });
       console.log("GOT " + cores);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  waiter.stdout.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => waiter.on("exit", resolve));

  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.match(output, /WAIT/);
  assert.doesNotMatch(output, /GOT/, "it must still be waiting while the pool is full");
  assert.equal(waiter.exitCode, null);

  fs.rmSync(holder.leasePath);
  assert.equal(await exited, 0);
  assert.match(output, /GOT 8/);
});
