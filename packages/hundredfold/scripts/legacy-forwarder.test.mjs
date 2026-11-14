import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The old command name runs the built forwarder, which must behave as the current command does: its output on
// stdout, its notice on stderr, and the exit code of what it ran.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forwarder = path.join(packageRoot, "dist/bin/legacy-forwarder.js");
const current = path.join(packageRoot, "dist/bin/hundredfold.js");

function run(file, ...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forwarder-"));
  try {
    return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: home, HUNDREDFOLD_HOME: path.join(home, ".hundredfold-test") } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the forwarder runs the command it was given and passes its output through", () => {
  const direct = run(current, "--version");
  const forwarded = run(forwarder, "--version");
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(forwarded.status, 0, forwarded.stderr);
  assert.match(forwarded.stdout, /^Hundredfold \d/);
  assert.equal(forwarded.stdout, direct.stdout);
  assert.match(forwarded.stderr, /renamed/);
});

test("the forwarder exits with the failure of the command it ran", () => {
  const direct = run(current, "no-such-command");
  const forwarded = run(forwarder, "no-such-command");
  assert.notEqual(direct.status, 0);
  assert.equal(forwarded.status, direct.status);
  assert.match(forwarded.stderr, /unknown command/);
});
