import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const helper = path.join(repo, "scripts/jinn-sandbox.sh")

/** Runs the helper under a throwaway HOME, exactly as the verify scripts do. */
function run(host, args, env = {}) {
  return spawnSync(helper, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: host, JINN_REPO: repo, ...env },
  })
}

function withHost(fn) {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-helper-test-"))
  try { return fn(fs.realpathSync(host)) } finally { fs.rmSync(host, { recursive: true, force: true }) }
}

test("create refuses the live gateway ports and anything below 8060", () => {
  withHost((host) => {
    for (const port of ["7777", "7788", "8059", "0", "65536", "abc", "80 60"]) {
      const result = run(host, ["create", "refused", "--port", port])
      assert.equal(result.status, 2, `port ${port}: ${result.stderr}`)
      assert.equal(fs.existsSync(path.join(host, ".jinn-refused")), false, `port ${port} left a directory behind`)
    }
  })
})

test("create needs a port and rejects unknown flags", () => {
  withHost((host) => {
    assert.equal(run(host, ["create", "no-port"]).status, 2)
    assert.equal(run(host, ["create", "bad-flag", "--port", "8060", "--nope"]).status, 2)
  })
})

test("instance names cannot reach the operator's instance or escape the home", () => {
  withHost((host) => {
    for (const name of ["jinn", "../escape", "a/b", "Upper", "1leading", ""]) {
      assert.equal(run(host, ["create", name, "--port", "8060"]).status, 2, `name ${JSON.stringify(name)}`)
    }
  })
})

test("a caller's own live instance variables do not reach the sandbox", () => {
  withHost((host) => {
    const result = run(host, ["destroy", "absent", "--yes"], { JINN_HOME: "/nonexistent-live-home", JINN_PORT: "7777" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /does not exist/)
  })
})

test("destroy needs --yes and only removes a directory the helper created", () => {
  withHost((host) => {
    const home = path.join(host, ".jinn-foreign")
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, "keep.txt"), "mine")
    assert.equal(run(host, ["destroy", "foreign"]).status, 2)
    const refused = run(host, ["destroy", "foreign", "--yes"])
    assert.equal(refused.status, 2, refused.stderr)
    assert.equal(fs.readFileSync(path.join(home, "keep.txt"), "utf8"), "mine")
  })
})

test("start and stop refuse an instance the helper never created", () => {
  withHost((host) => {
    assert.equal(run(host, ["start", "missing"]).status, 2)
    assert.equal(run(host, ["stop", "missing"]).status, 2)
  })
})

test("refuses to run against the operator's real home", () => {
  const result = run(os.userInfo().homedir, ["create", "real-home", "--port", "8060"])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /real home/)
})
