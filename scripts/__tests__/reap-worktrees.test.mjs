import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { classifyWorktree, todoIdFromWorktree } from "../reap/worktrees.mjs"

const REAP = fileURLToPath(new URL("../reap-sandboxes.mjs", import.meta.url))

const WORKTREES = path.join(os.tmpdir(), "reap-fixture", ".worktrees")
const REPO = path.join(os.tmpdir(), "reap-fixture", "jinn")

/** Nothing here may depend on the developer's git config. */
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }

function candidate(overrides = {}) {
  return {
    path: path.join(WORKTREES, "jinn-build-TEST-1-a-feature"),
    dirty: false,
    ageMinutes: 300,
    merged: false,
    todoStatus: "executing",
    ...overrides,
  }
}

const OPTIONS = { worktreesRoot: WORKTREES, minAgeMinutes: 120 }

const CASES = [
  {
    name: "a dirty tree is kept even when it is merged",
    candidate: candidate({ dirty: true, merged: true }),
    prune: false,
    reason: "uncommitted-changes",
  },
  {
    name: "a tree git still lists but that is gone from disk is left to the prune",
    candidate: candidate({ missing: true, merged: true }),
    prune: false,
    reason: "already-gone",
  },
  {
    name: "a tree younger than the age guard is kept even when it is merged",
    candidate: candidate({ ageMinutes: 30, merged: true }),
    prune: false,
    reason: "too-young",
  },
  {
    name: "a clean tree merged into main is pruned",
    candidate: candidate({ merged: true }),
    prune: true,
    reason: "merged-into-main",
  },
  {
    name: "a clean unmerged tree whose Todo is done is pruned",
    candidate: candidate({ todoStatus: "done" }),
    prune: true,
    reason: "todo-closed",
  },
  {
    name: "a clean unmerged tree whose Todo is cancelled is pruned",
    candidate: candidate({ todoStatus: "cancelled" }),
    prune: true,
    reason: "todo-closed",
  },
  {
    name: "a clean unmerged tree whose Todo is still open is kept",
    candidate: candidate({ todoStatus: "executing" }),
    prune: false,
    reason: "todo-open",
  },
  {
    name: "an unreachable work-item lookup skips the rule instead of pruning",
    candidate: candidate({ todoStatus: null }),
    prune: false,
    reason: "todo-unknown",
  },
  {
    name: "the repo checkout itself is structurally ineligible",
    candidate: candidate({ path: REPO, merged: true }),
    prune: false,
    reason: "not-a-build-worktree",
  },
  {
    name: "a nested path under .worktrees is ineligible",
    candidate: candidate({ path: path.join(WORKTREES, "jinn-build-TEST-1", "packages"), merged: true }),
    prune: false,
    reason: "not-a-build-worktree",
  },
  {
    name: "a directly-nested directory not named jinn-* is ineligible",
    candidate: candidate({ path: path.join(WORKTREES, "scratch"), merged: true }),
    prune: false,
    reason: "not-a-build-worktree",
  },
]

for (const testCase of CASES) {
  test(`classifyWorktree: ${testCase.name}`, () => {
    const verdict = classifyWorktree(testCase.candidate, OPTIONS)
    assert.deepEqual(verdict, { prune: testCase.prune, reason: testCase.reason })
  })
}

test("todoIdFromWorktree reads the Todo out of the directory name", () => {
  assert.equal(todoIdFromWorktree(path.join(WORKTREES, "jinn-build-TSK-83-reap-sandboxes")), "TSK-83")
  assert.equal(todoIdFromWorktree(path.join(WORKTREES, "jinn-patch-ABC-7")), "ABC-7")
  assert.equal(todoIdFromWorktree(path.join(WORKTREES, "jinn-scratch")), null)
})

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=reap", "-c", "user.email=reap@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: HERMETIC,
  })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function backdate(dir, minutes) {
  const when = new Date(Date.now() - minutes * 60_000)
  fs.utimesSync(dir, when, when)
}

test("a bare run removes nothing; --apply prunes only the merged clean tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-wt-"))
  const repo = path.join(root, "jinn")
  const trees = path.join(root, ".worktrees")
  try {
    fs.mkdirSync(repo, { recursive: true })
    git(repo, "init", "--initial-branch=main", ".")
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "seed")

    const merged = path.join(trees, "jinn-build-TEST-1-merged")
    const dirty = path.join(trees, "jinn-build-TEST-2-dirty")
    const open = path.join(trees, "jinn-build-TEST-3-open")
    // Deleted by hand, so git keeps listing metadata for a directory that is no
    // longer there. Inspecting it must not take the sweep down.
    const gone = path.join(trees, "jinn-build-TEST-4-gone")
    git(repo, "worktree", "add", "-b", "merged-branch", merged, "main")
    git(repo, "worktree", "add", "-b", "dirty-branch", dirty, "main")
    git(repo, "worktree", "add", "-b", "open-branch", open, "main")
    git(repo, "worktree", "add", "-b", "gone-branch", gone, "main")
    fs.writeFileSync(path.join(dirty, "scratch.txt"), "work in progress\n")
    fs.writeFileSync(path.join(open, "feature.txt"), "shipped\n")
    git(open, "add", "-A")
    git(open, "commit", "-m", "unmerged work")
    for (const tree of [merged, dirty, open]) backdate(tree, 300)
    fs.rmSync(gone, { recursive: true, force: true })

    const env = { ...HERMETIC, JINN_HOME: path.join(root, ".jinn"), JINN_REAP_PS_SOURCE: "/dev/null" }
    const run = (...args) =>
      spawnSync(process.execPath, [REAP, "--repo", repo, ...args], { encoding: "utf8", env })

    const dry = run()
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /PRUNE\s+.*jinn-build-TEST-1-merged\s+merged-into-main/)
    assert.match(dry.stdout, /jinn-build-TEST-4-gone\s+already-gone/)
    assert.ok(fs.existsSync(merged), "a bare run must remove nothing")

    // The sweep is routinely launched from inside a worktree. Anchoring on the
    // caller's directory puts the worktrees root a level too deep, and the run
    // finds nothing at all rather than failing.
    const nested = spawnSync(process.execPath, [REAP, "--repo", open], { encoding: "utf8", env })
    assert.equal(nested.status, 0, nested.stderr)
    assert.match(nested.stdout, /PRUNE\s+.*jinn-build-TEST-1-merged\s+merged-into-main/)

    const applied = run("--apply")
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(fs.existsSync(merged), false, "the merged clean tree should be gone")
    assert.ok(fs.existsSync(dirty), "a dirty tree is never removed")
    assert.ok(fs.existsSync(open), "an unmerged tree with no Todo verdict is kept")
    assert.ok(fs.existsSync(repo), "the repo checkout is never a candidate")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The plan is made before processes are signalled, and the grace wait is long
 * enough for a live run to write into a tree that was clean when it was judged.
 * A dirty tree is never removed, and "clean at planning time" is not the same
 * claim.
 */
test("a tree that turns dirty during the process grace wait is preserved", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-grace-"))
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-"))
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" })
  t.after(() => {
    victim.kill("SIGKILL")
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(sandbox, { recursive: true, force: true })
  })

  const repo = path.join(root, "jinn")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "--initial-branch=main", ".")
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "seed")
  const merged = path.join(root, ".worktrees", "jinn-build-TEST-5-merged")
  git(repo, "worktree", "add", "-b", "grace-branch", merged, "main")
  backdate(merged, 300)

  // A reap target is what makes the run wait at all: no processes, no grace.
  fs.writeFileSync(path.join(sandbox, "gateway.json"), JSON.stringify({ pid: victim.pid, ptyPids: [] }))
  const psDump = path.join(root, "ps.txt")
  const gatewayArgs = "node /repo/packages/jinn/dist/src/gateway/daemon-entry.js"
  fs.writeFileSync(psDump, `${victim.pid} 1 05:00:00 90000 ${gatewayArgs}\n`)

  const env = {
    ...HERMETIC,
    JINN_HOME: path.join(root, ".jinn"),
    JINN_REAP_PS_SOURCE: psDump,
    JINN_REAP_PROTECTED_PORTS: "",
  }
  const run = spawn(process.execPath, [REAP, "--repo", repo, "--apply", "--grace-seconds", "3"], { stdio: "ignore", env })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  fs.writeFileSync(path.join(merged, "dirty-during-grace.txt"), "late work\n")
  await once(run, "exit")

  assert.ok(fs.existsSync(merged), "a tree that turned dirty after the plan must survive the removal")
})
