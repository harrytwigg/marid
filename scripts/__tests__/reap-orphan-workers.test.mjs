// Ownership of a parentless test worker, which the sweep has to prove rather
// than recognise. Every case here is the same question asked differently: does
// this run hold the authority to kill this PID, and can it show it? No fixture
// tree is ever created on disk, because the answer may never depend on one.
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { planProcessReap } from "../reap/gateways.mjs"

const TEMP = os.tmpdir()
const WORKTREES_ROOT = path.join(TEMP, "reap-orphan-fixture", ".worktrees")
const REMOVED_TREE = path.join(WORKTREES_ROOT, "hundredfold-build-TEST-1")
const ACTIVE_TREE = path.join(WORKTREES_ROOT, "hundredfold-build-ACTIVE")

const workerIn = (tree) => `node ${path.join(tree, "node_modules", "vitest", "dist", "worker.js")}`

function context(pruningWorktrees, overrides = {}) {
  return {
    defaultHome: path.join(TEMP, "reap-orphan-fixture", ".hundredfold"),
    registeredHomes: [],
    homeByPid: {},
    protectedPortPids: [],
    throwawayRoots: [TEMP],
    pruningWorktrees,
    minAgeMinutes: 120,
    selfPids: [],
    ...overrides,
  }
}

const orphan = (pid, args, ageMinutes = 300) => ({ pid, ppid: 1, ageMinutes, rssKiB: 900, args })
const runningIn = (candidate, cwd) => ({ ...candidate, cwd })

function orphanTargets(processes, pruningWorktrees, overrides) {
  const plan = planProcessReap(processes, context(pruningWorktrees, overrides))
  return plan.targets.filter((target) => target.kind === "orphan-test-worker").map((target) => target.pid)
}

// The one the verifier demonstrated: a real parentless worker whose command
// line names a path inside the tree being removed — a path that does not even
// exist — and which nothing can place anywhere.
test("a worker naming a removed tree is spared when nobody can say where it runs", () => {
  assert.deepEqual(orphanTargets([orphan(9301, workerIn(REMOVED_TREE))], [REMOVED_TREE]), [])
})

test("a worker that names a removed tree but runs somewhere else is spared", () => {
  const elsewhere = runningIn(orphan(9302, workerIn(REMOVED_TREE)), ACTIVE_TREE)
  assert.deepEqual(orphanTargets([elsewhere], [REMOVED_TREE]), [])
})

test("a worker running inside a tree this run removes is reaped", () => {
  const inside = runningIn(orphan(9303, "node ./vitest-worker.js"), REMOVED_TREE)
  assert.deepEqual(orphanTargets([inside], [REMOVED_TREE]), [9303])
  const nested = runningIn(inside, path.join(REMOVED_TREE, "packages", "hundredfold"))
  assert.deepEqual(orphanTargets([nested], [REMOVED_TREE]), [9303])
})

test("a sibling tree whose name merely starts with a removed one's is spared", () => {
  const sibling = path.join(WORKTREES_ROOT, "hundredfold-build-TEST-12")
  assert.deepEqual(orphanTargets([runningIn(orphan(9304, workerIn(sibling)), sibling)], [REMOVED_TREE]), [])
})

test("no worktree is being removed, so no orphan can be owned", () => {
  assert.deepEqual(orphanTargets([runningIn(orphan(9305, workerIn(REMOVED_TREE)), REMOVED_TREE)], []), [])
})

test("a worker that is not a test runner is spared even from inside a removed tree", () => {
  const server = runningIn(orphan(9306, `node ${path.join(REMOVED_TREE, "server.js")}`), REMOVED_TREE)
  assert.deepEqual(orphanTargets([server], [REMOVED_TREE]), [])
})

test("the age guard and every untouchable reason still outrank a proven tree", () => {
  const young = runningIn(orphan(9307, workerIn(REMOVED_TREE), 4), REMOVED_TREE)
  assert.deepEqual(orphanTargets([young], [REMOVED_TREE]), [])
  const owned = runningIn(orphan(9308, workerIn(REMOVED_TREE)), REMOVED_TREE)
  assert.deepEqual(orphanTargets([owned], [REMOVED_TREE], { protectedPortPids: [9308] }), [])
  assert.deepEqual(orphanTargets([owned], [REMOVED_TREE], { selfPids: [9308] }), [])
  assert.deepEqual(orphanTargets([owned], [REMOVED_TREE], { homeByPid: { 9308: path.join(TEMP, "registered") }, registeredHomes: [path.join(TEMP, "registered")] }), [])
})
