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

/**
 * A repo just real enough for the helper: the CLI entry exists (the helper only checks for it) and
 * js-yaml resolves, through the real checkout's modules, the way the helper reads gateway.port.
 */
function fakeRepo(root) {
  const jinn = path.join(root, "repo/packages/jinn")
  fs.mkdirSync(path.join(jinn, "dist/bin"), { recursive: true })
  fs.writeFileSync(path.join(jinn, "package.json"), "{}")
  fs.writeFileSync(path.join(jinn, "dist/bin/jinn.js"), "")
  fs.symlinkSync(path.join(repo, "packages/jinn/node_modules"), path.join(jinn, "node_modules"))
  return path.join(root, "repo")
}

/**
 * A sandbox as `create` leaves it: marker plus a config.yaml declaring `port`.
 * @param {string} host
 * @param {string} name
 * @param {{ port?: number, config?: string }} [options]
 */
function fakeSandbox(host, name, { port = 8089, config } = {}) {
  const home = path.join(host, `.jinn-${name}`)
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, ".jinn-sandbox.json"), JSON.stringify({ instance: name, port }))
  fs.writeFileSync(path.join(home, "config.yaml"), config ?? `gateway:\n  port: ${port}\n`)
  return home
}

/** Stands in for node when the helper runs the Marid CLI, and records the environment it was given. */
function envStub(root) {
  const stub = path.join(root, "node-stub.sh")
  fs.writeFileSync(stub, `#!/bin/sh\nenv > "$STUB_ENV_OUT"\nexit 0\n`, { mode: 0o755 })
  return stub
}

test("the CLI is run with the sandbox's identity and none of the caller's", () => {
  withHost((host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-helper-stub-"))
    try {
      const fake = fakeRepo(root)
      const home = fakeSandbox(host, "probe")
      const out = path.join(root, "env.txt")
      const result = run(host, ["start", "probe"], {
        JINN_REPO: fake,
        JINN_SANDBOX_NODE_BIN: envStub(root),
        JINN_SANDBOX_HEALTH_TIMEOUT: "1",
        STUB_ENV_OUT: out,
        JINN_HOME: "/live/instance",
        JINN_PORT: "7777",
        JINN_GATEWAY_URL: "http://127.0.0.1:7777",
        JINN_GATEWAY_TOKEN: "live-token",
        JINN_INSTANCE: "jinn",
        JINN_SESSION_ID: "live-session",
        CLAUDE_CONFIG_DIR: "/live/claude",
      })
      // Nothing listens on 8089, so the health wait gives up; the environment is what is under test.
      assert.equal(result.status, 1, result.stderr)
      const seen = Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      }))
      assert.equal(seen.JINN_HOME, fs.realpathSync(home))
      assert.equal(seen.HOME, host)
      for (const key of ["JINN_PORT", "JINN_GATEWAY_URL", "JINN_GATEWAY_TOKEN", "JINN_INSTANCE", "JINN_SESSION_ID", "CLAUDE_CONFIG_DIR"]) {
        assert.equal(seen[key], undefined, `${key} leaked into the CLI environment`)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

test("the port is read the way the gateway reads it, and a live one is refused at start", () => {
  withHost((host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-helper-port-"))
    try {
      const fake = fakeRepo(root)
      // A nested `tls.port` precedes the real `port`: a line scanner reads 8443, the gateway reads 7777.
      fakeSandbox(host, "nested", { config: "gateway:\n  tls:\n    port: 8443\n  port: 7777\n" })
      const nested = run(host, ["start", "nested"], { JINN_REPO: fake })
      assert.equal(nested.status, 2, nested.stderr)
      assert.match(nested.stderr, /7777/)
      fakeSandbox(host, "stringy", { config: 'gateway:\n  port: "8089"\n' })
      assert.notEqual(run(host, ["start", "stringy"], { JINN_REPO: fake }).status, 0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

test("a HOME inside the operator's instance home is refused", () => {
  const real = fs.realpathSync(os.userInfo().homedir)
  for (const inside of [".jinn", ".jinn/knowledge"]) {
    const dir = path.join(real, inside)
    if (!fs.existsSync(dir)) continue // nothing to point HOME at on a machine without one
    // `start` writes nothing, so a failed refusal cannot touch the directory it was pointed at.
    const result = run(dir, ["start", "probe"])
    assert.equal(result.status, 2, `${inside}: ${result.stderr}`)
    assert.match(result.stderr, /operator/)
  }
})

test("a case-variant spelling of the operator's home or instance home is refused", () => {
  const real = fs.realpathSync(os.userInfo().homedir)
  for (const inside of ["", ".jinn", ".jinn/knowledge"]) {
    const dir = path.join(real, inside)
    if (!fs.existsSync(dir)) continue
    const upper = dir.toUpperCase()
    // Only meaningful where the volume folds case, as macOS volumes do by default.
    if (!fs.existsSync(upper)) continue
    const result = run(upper, ["start", "probe"])
    assert.equal(result.status, 2, `${upper}: ${result.stderr}`)
    assert.match(result.stderr, /operator/)
  }
})

/** Stands in for node when the helper runs the Marid CLI, and appends each argv it was given. */
function argvStub(root) {
  const stub = path.join(root, "node-argv-stub.sh")
  fs.writeFileSync(stub, `#!/bin/sh\necho "$*" >> "$STUB_ARGV_OUT"\nexit 0\n`, { mode: 0o755 })
  return stub
}

test("every stop names the sandbox's port, even when config.yaml cannot be read", () => {
  withHost((host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-helper-argv-"))
    try {
      const fake = fakeRepo(root)
      const out = path.join(root, "argv.txt")
      const env = { JINN_REPO: fake, JINN_SANDBOX_NODE_BIN: argvStub(root), JINN_SANDBOX_HEALTH_TIMEOUT: "1", STUB_ARGV_OUT: out }
      fakeSandbox(host, "healthless", { port: 8091 })
      assert.equal(run(host, ["start", "healthless"], env).status, 1) // nothing listens, so start stops it again
      assert.equal(run(host, ["stop", "healthless"], env).status, 0)
      // An unreadable config leaves only the port recorded at create.
      fakeSandbox(host, "broken", { port: 8092, config: "gateway: [unclosed\n" })
      const destroyed = run(host, ["destroy", "broken", "--yes"], env)
      assert.equal(destroyed.status, 0, destroyed.stderr)
      const stops = fs.readFileSync(out, "utf8").split("\n").filter((line) => / stop\b/.test(line))
      assert.equal(stops.length, 3, stops.join("\n"))
      assert.match(stops[0], / stop --port 8091$/)
      assert.match(stops[1], / stop --port 8091$/)
      assert.match(stops[2], / stop --port 8092$/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

test("ports must be plain four or five digit integers", () => {
  withHost((host) => {
    for (const port of ["18446744073709559676", "08080", "+8060", "-8060", "8060.5"]) {
      assert.equal(run(host, ["create", "wrapped", "--port", port]).status, 2, `port ${port}`)
    }
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

/** Stands in for `jinn setup`: writes the config.yaml it would, and the jobs file when STUB_JOBS is set. */
function setupStub(root) {
  const stub = path.join(root, "setup-stub.sh")
  fs.writeFileSync(stub, `#!/bin/sh
mkdir -p "$JINN_HOME"
printf 'gateway:\\n  port: 8089\\nportal:\\n  companyName: X\\n' > "$JINN_HOME/config.yaml"
if [ -n "$STUB_JOBS" ]; then mkdir -p "$JINN_HOME/cron"; printf '%s' "$STUB_JOBS" > "$JINN_HOME/cron/jobs.json"; fi
exit 0
`, { mode: 0o755 })
  return stub
}

/** Creates a sandbox with the real helper and a stubbed `jinn setup`, and returns the jobs file it left. */
function createdJobs(setupJobs) {
  return withHost((host) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-helper-setup-"))
    try {
      const result = run(host, ["create", "scheduled", "--port", "8089"], {
        JINN_SANDBOX_NODE_BIN: setupStub(root),
        ...(setupJobs ? { STUB_JOBS: JSON.stringify(setupJobs) } : {}),
      })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(fs.readFileSync(path.join(host, ".jinn-scheduled", "cron", "jobs.json"), "utf8"))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

const built = fs.existsSync(path.join(repo, "packages/jinn/dist/bin/jinn.js")) && fs.existsSync(path.join(repo, "packages/jinn/dist/src/shared/config-document.js"))

test("a created sandbox starts no scheduled turn: the board walk is added switched off", { skip: !built && "needs a built checkout" }, () => {
  const jobs = createdJobs(null)
  assert.deepEqual(jobs.map((job) => [job.id, job.action, job.enabled]), [["board-walk", "board-walk", false]])
})

test("a board walk or any other job that setup left switched on is switched off", { skip: !built && "needs a built checkout" }, () => {
  const jobs = createdJobs([
    { id: "board-walk", name: "Board walk", enabled: true, schedule: "0 * * * *", prompt: "", action: "board-walk" },
    { id: "digest", name: "Digest", enabled: true, schedule: "0 9 * * *", prompt: "Summarise the day" },
  ])
  assert.deepEqual(jobs.map((job) => [job.id, job.enabled]), [["board-walk", false], ["digest", false]])
  assert.equal(jobs[1].prompt, "Summarise the day")
})
