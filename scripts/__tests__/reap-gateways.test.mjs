import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { classifyGateway, parsePsDump, planProcessReap } from "../reap/gateways.mjs"
import { buildContext, mapPidsToHomes } from "../reap/protected.mjs"

const REAP = fileURLToPath(new URL("../reap-sandboxes.mjs", import.meta.url))

const TEMP = os.tmpdir()
const DEFAULT_HOME = path.join(TEMP, "reap-fixture", ".hundredfold")
const REGISTERED_HOME = path.join(TEMP, "reap-fixture", ".hundredfold-second")
const SETTLED_HOME = path.join(os.homedir(), ".hundredfold-unregistered")
const SANDBOX_HOME = path.join(TEMP, "hundredfold-sandbox-abc")
const WORKTREES_ROOT = path.join(TEMP, "reap-fixture", ".worktrees")

const GATEWAY_ARGS = "node /repo/packages/hundredfold/dist/src/gateway/daemon-entry.js"

/**
 * The fixture context every case starts from. `registeredHomes` deliberately
 * excludes `SETTLED_HOME`: an unregistered home outside the throwaway patterns
 * is the shape that must still be spared.
 */
function context(overrides = {}) {
  return {
    defaultHome: DEFAULT_HOME,
    registeredHomes: [REGISTERED_HOME],
    homeByPid: {},
    protectedPortPids: [],
    throwawayRoots: [TEMP],
    pruningWorktrees: [],
    minAgeMinutes: 120,
    selfPids: [],
    ...overrides,
  }
}

function gateway(pid, ageMinutes = 300) {
  return { pid, ppid: 1, ageMinutes, rssKiB: 100000, args: GATEWAY_ARGS }
}

const CASES = [
  {
    name: "a PID inside a registered instance's gateway.json is never reapable",
    candidate: gateway(9001),
    context: context({ homeByPid: { 9001: REGISTERED_HOME } }),
    reap: false,
    reason: "registered-instance",
  },
  {
    name: "a PID whose home is the default home is never reapable",
    candidate: gateway(9002),
    context: context({ homeByPid: { 9002: DEFAULT_HOME } }),
    reap: false,
    reason: "default-home",
  },
  {
    name: "a PID owning a protected port is never reapable",
    candidate: gateway(9003),
    context: context({ homeByPid: { 9003: SANDBOX_HOME }, protectedPortPids: [9003] }),
    reap: false,
    reason: "protected-port",
  },
  {
    name: "a gateway PID mapping to no known home is never reapable",
    candidate: gateway(9004),
    context: context(),
    reap: false,
    reason: "unidentified",
  },
  {
    name: "a known home that matches no throwaway pattern is never reapable",
    candidate: gateway(9005),
    context: context({ homeByPid: { 9005: SETTLED_HOME } }),
    reap: false,
    reason: "home-not-throwaway",
  },
  {
    name: "a home under the system temp dir, older than the age guard, is reapable",
    candidate: gateway(9006),
    context: context({ homeByPid: { 9006: path.join(TEMP, "hundredfold-home-xyz") } }),
    reap: true,
    reason: "throwaway-home",
  },
  {
    name: "a hundredfold-sandbox-* home outside the temp dir is reapable",
    candidate: gateway(9007),
    context: context({ homeByPid: { 9007: path.join(os.homedir(), "hundredfold-sandbox-abc") } }),
    reap: true,
    reason: "throwaway-home",
  },
  {
    name: "an upgrade-lab-* home is reapable",
    candidate: gateway(9008),
    context: context({ homeByPid: { 9008: path.join(os.homedir(), "upgrade-lab-7") } }),
    reap: true,
    reason: "throwaway-home",
  },
  {
    name: "the same throwaway home younger than the age guard is spared",
    candidate: gateway(9006, 9),
    context: context({ homeByPid: { 9006: path.join(TEMP, "hundredfold-home-xyz") } }),
    reap: false,
    reason: "too-young",
  },
  {
    name: "this process's own tree is never reapable",
    candidate: gateway(9009),
    context: context({ homeByPid: { 9009: SANDBOX_HOME }, selfPids: [9009] }),
    reap: false,
    reason: "self",
  },
]

for (const testCase of CASES) {
  test(`classifyGateway: ${testCase.name}`, () => {
    const verdict = classifyGateway(testCase.candidate, testCase.context)
    assert.deepEqual(verdict, { reap: testCase.reap, reason: testCase.reason })
  })
}

test("parsePsDump keeps the whole command line as one field", () => {
  const dump = `  501     1 02-03:04:05  123456 ${GATEWAY_ARGS} --port 7900\n 9  1 00:30 10 node -e x\n`
  assert.deepEqual(parsePsDump(dump), [
    { pid: 501, ppid: 1, ageMinutes: 3064, rssKiB: 123456, args: `${GATEWAY_ARGS} --port 7900` },
    { pid: 9, ppid: 1, ageMinutes: 1, rssKiB: 10, args: "node -e x" },
  ])
})

/** A test worker's argv. Only the cwd paired with it decides whose worker it is. */
const REMOVED_WORKTREE = path.join(WORKTREES_ROOT, "hundredfold-build-TEST-1")
const WORKER_IN_WORKTREE = `node ${path.join(REMOVED_WORKTREE, "node_modules", "vitest", "dist", "worker.js")}`

test("planProcessReap sweeps a reaped gateway's children and orphaned test workers", () => {
  const processes = [
    gateway(9101),
    gateway(9102),
    { pid: 9103, ppid: 9101, ageMinutes: 300, rssKiB: 900, args: "node /repo/worker.js" },
    { pid: 9104, ppid: 9102, ageMinutes: 300, rssKiB: 900, args: "node /repo/worker.js" },
    { pid: 9105, ppid: 1, ageMinutes: 300, rssKiB: 900, args: WORKER_IN_WORKTREE, cwd: REMOVED_WORKTREE },
    { pid: 9106, ppid: 1, ageMinutes: 4, rssKiB: 900, args: WORKER_IN_WORKTREE, cwd: REMOVED_WORKTREE },
    // The operator's own `vitest --watch`, reparented to PID 1 when its shell
    // closed. Nothing but the name says it is ours, so it is not ours.
    { pid: 9107, ppid: 1, ageMinutes: 300, rssKiB: 900, args: "node /elsewhere/node_modules/vitest/dist/worker.js" },
  ]
  const plan = planProcessReap(
    processes,
    context({ homeByPid: { 9101: SANDBOX_HOME, 9102: REGISTERED_HOME }, pruningWorktrees: [REMOVED_WORKTREE] }),
  )
  assert.deepEqual(
    plan.targets.map((target) => [target.pid, target.kind, target.reason]),
    [
      [9101, "sandbox-gateway", "throwaway-home"],
      [9103, "gateway-child", "child-of-9101"],
      [9105, "orphan-test-worker", "orphaned"],
    ],
  )
  assert.equal(plan.spared.find((entry) => entry.pid === 9102).reason, "registered-instance")
})

/**
 * A registered instance may legitimately live on a throwaway-looking home — a
 * sandbox instance registered through the CLI is exactly that. Reading the
 * registry the running gateway actually writes is what tells the two apart.
 */
function registryFixture(t, contents) {
  const root = fs.mkdtempSync(path.join(TEMP, "reap-registry-"))
  const home = fs.mkdtempSync(path.join(TEMP, "hundredfold-sandbox-"))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ pid: 9201, ptyPids: [] }))
  const registry = path.join(root, "instances.json")
  const instance = { id: "fixture", name: "registered", port: 65_123, home, createdAt: "2026-01-01T00:00:00.000Z" }
  fs.writeFileSync(registry, JSON.stringify(contents(instance)))
  return { root, home, registry }
}

function contextFromRegistry(fixture, overrides = {}) {
  return buildContext({
    env: {
      ...process.env,
      HUNDREDFOLD_HOME: path.join(fixture.root, ".hundredfold"),
      HUNDREDFOLD_REAP_PROTECTED_PORTS: "",
      ...overrides,
    },
    minAgeMinutes: 120,
    selfPids: [],
    pruningWorktrees: [],
  })
}

test("a stale duplicate PID claim cannot replace the authoritative registered home", (t) => {
  const registered = fs.mkdtempSync(path.join(TEMP, "reap-registered-"))
  const stale = fs.mkdtempSync(path.join(TEMP, "hundredfold-sandbox-stale-"))
  t.after(() => fs.rmSync(registered, { recursive: true, force: true }))
  t.after(() => fs.rmSync(stale, { recursive: true, force: true }))
  fs.writeFileSync(path.join(registered, "gateway.json"), JSON.stringify({ pid: 9201, ptyPids: [] }))
  fs.writeFileSync(path.join(stale, "gateway.json"), JSON.stringify({ pid: 9201, ptyPids: [] }))
  assert.deepEqual(mapPidsToHomes([registered, stale]), { 9201: registered })
})

test("a schema-v2 registry protects the instances it lists", (t) => {
  const fixture = registryFixture(t, (instance) => ({ schemaVersion: 2, instances: [instance] }))
  const built = contextFromRegistry(fixture, { HUNDREDFOLD_INSTANCES_REGISTRY: fixture.registry })
  assert.ok(built.registeredHomes.includes(fixture.home), "the registered home must be protected")
  assert.deepEqual(classifyGateway(gateway(9201), built), { reap: false, reason: "registered-instance" })
})

test("the pre-host-registry array inside the home is still honoured", (t) => {
  const fixture = registryFixture(t, (instance) => [instance])
  const legacyHome = path.join(fixture.root, ".hundredfold")
  fs.mkdirSync(legacyHome, { recursive: true })
  fs.renameSync(fixture.registry, path.join(legacyHome, "instances.json"))
  const built = contextFromRegistry(fixture)
  assert.ok(built.registeredHomes.includes(fixture.home), "the registered home must be protected")
  assert.deepEqual(classifyGateway(gateway(9201), built), { reap: false, reason: "registered-instance" })
})

/**
 * The one that matters: a real, live process the plan targets must survive a
 * bare run and die only under `--apply`, while a real, live process the plan
 * does not own must survive both. Nothing else proves the apply path is gated
 * rather than merely written, or that ownership is proven rather than guessed.
 */
test("a bare run signals nothing; --apply reaps what this run owns and nothing else", async (t) => {
  const root = fs.mkdtempSync(path.join(TEMP, "reap-cli-"))
  const home = path.join(root, ".hundredfold")
  const sandbox = fs.mkdtempSync(path.join(TEMP, "hundredfold-sandbox-"))
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  // Reparented to PID 1, named like a test worker, sitting under the worktrees
  // root — and belonging to nobody. This run removes no worktree, so there is
  // nothing to own it and it must come through untouched.
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  t.after(() => {
    victim.kill("SIGKILL")
    worker.kill("SIGKILL")
    bystander.kill("SIGKILL")
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(sandbox, { recursive: true, force: true })
  })

  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "instances.json"), "[]")
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ pid: 1, ptyPids: [] }))
  fs.writeFileSync(path.join(sandbox, "gateway.json"), JSON.stringify({ pid: victim.pid, ptyPids: [] }))
  const psDump = path.join(root, "ps.txt")
  const strayWorker = path.join(root, ".worktrees", "hundredfold-build-ACTIVE", "node_modules", "vitest", "dist", "worker.js")
  fs.writeFileSync(
    psDump,
    `${victim.pid} 1 05:00:00 90000 ${GATEWAY_ARGS}\n` +
      `${worker.pid} ${victim.pid} 05:00:00 900 node /repo/worker.js\n` +
      `${bystander.pid} 1 05:00:00 900 node ${strayWorker}\n`,
  )

  const env = {
    ...process.env,
    HUNDREDFOLD_HOME: home,
    HUNDREDFOLD_REAP_PS_SOURCE: psDump,
    HUNDREDFOLD_REAP_PROTECTED_PORTS: "",
  }
  const run = (...args) =>
    spawnSync(process.execPath, [REAP, "--repo", path.join(root, "repo"), ...args], {
      encoding: "utf8",
      env,
    })

  const dry = run()
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, new RegExp(`REAP\\s+pid=${victim.pid}`))
  assert.match(dry.stdout, /Spared/)
  assert.doesNotMatch(dry.stdout, new RegExp(`pid=${bystander.pid}`), "an unowned worker must not appear in the plan")
  // A signalled child lingers as a zombie the parent can still `kill(pid, 0)`,
  // so liveness is read off the handle rather than off the process table.
  await settle()
  assert.equal(victim.exitCode ?? victim.signalCode, null, "a bare run must not signal the gateway")
  assert.equal(worker.exitCode ?? worker.signalCode, null, "a bare run must not signal its children")

  const applied = run("--apply", "--grace-seconds", "1")
  assert.equal(applied.status, 0, applied.stderr)
  await waitForExit(victim, "gateway")
  await waitForExit(worker, "child worker")
  assert.equal(bystander.exitCode ?? bystander.signalCode, null, "--apply must not signal an unowned worker")
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

async function waitForExit(child, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((child.exitCode ?? child.signalCode) !== null) return
    await settle()
  }
  assert.fail(`the ${label} survived --apply`)
}
