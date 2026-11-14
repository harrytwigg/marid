#!/usr/bin/env node
// Reap throwaway gateways and dead build worktrees, safely, at any time.
//
// Two leaks converge here. Build and QA runs spawn gateways on temp homes and
// rely on remembering to stop them, so strays accumulate until swap eats the
// disk. Runs that die mid-phase never reach their cleanup step, so their
// worktrees stay forever. Both are decided by evidence — a `gateway.json` that
// claims a PID, a branch that is merged, a Todo that is closed — never by age
// or by a path that looks disposable.
//
// DRY RUN BY DEFAULT. Nothing is signalled or removed without --apply.
//
//   pnpm reap                          # print the plan
//   pnpm reap --apply                  # act on it
//   pnpm reap --apply --min-age-min 360
//   pnpm reap --json                   # machine-readable plan
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parentlessWorkerPids, parsePsDump, planProcessReap } from "./reap/gateways.mjs"
import { buildContext, gatewayEndpoint, resolveDefaultHome, readRegisteredInstances } from "./reap/protected.mjs"
import {
  classifyWorktree,
  fetchTodoStatus,
  gitRunner,
  inspectWorktree,
  listWorktrees,
  mainCheckout,
  realPath,
  todoIdFromWorktree,
} from "./reap/worktrees.mjs"

// Flat, not a flag: a tree younger than this may belong to a run that simply
// has not committed yet, and no invocation gets to argue otherwise.
const WORKTREE_MIN_AGE_MINUTES = 120

const DEFAULTS = {
  apply: false,
  json: false,
  minAgeMin: 120,
  graceSeconds: 8,
  repo: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  log: null,
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const flag = rest.shift()
    switch (flag) {
      case "--apply": options.apply = true; break
      case "--json": options.json = true; break
      case "--min-age-min": options.minAgeMin = Number(rest.shift()); break
      case "--grace-seconds": options.graceSeconds = Number(rest.shift()); break
      case "--repo": options.repo = path.resolve(String(rest.shift())); break
      case "--log": options.log = path.resolve(String(rest.shift())); break
      case "-h":
      case "--help": options.help = true; break
      default: throw new Error(`unknown option: ${flag}. Run with --help for the accepted flags.`)
    }
  }
  return options
}

function psDump(env) {
  if (env.HUNDREDFOLD_REAP_PS_SOURCE) return fs.readFileSync(env.HUNDREDFOLD_REAP_PS_SOURCE, "utf8")
  return execFileSync("/bin/ps", ["-eo", "pid=,ppid=,etime=,rss=,args="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/**
 * `pid → cwd` for the PIDs given. macOS has no `/proc` and `ps` has no cwd
 * column, so lsof is the answer. A PID that died between the dump and the probe
 * makes lsof exit non-zero with the rest of its output intact, so the status is
 * ignored and stdout is read either way.
 */
function workingDirectories(pids) {
  if (pids.length === 0) return {}
  const probe = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  const byPid = {}
  let pid = null
  for (const line of (probe.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== null) byPid[pid] = line.slice(1)
  }
  return byPid
}

/**
 * Where a parentless worker is running is the only thing that can claim it, and
 * `ps` cannot say. Only those workers are probed: they are the only PIDs the
 * answer can decide anything about, and one whose directory does not come back
 * stays unclaimed.
 */
function withWorkingDirectories(processes) {
  const cwdByPid = workingDirectories(parentlessWorkerPids(processes))
  return processes.map((candidate) =>
    cwdByPid[candidate.pid] ? { ...candidate, cwd: cwdByPid[candidate.pid] } : candidate,
  )
}

/** Every registered home, plus the default one, as spared entries a reader can check. */
function protectedHomeEntries(env) {
  const defaultHome = resolveDefaultHome(env)
  const entries = [{ kind: "home", label: defaultHome, reason: "default-home" }]
  for (const instance of readRegisteredInstances(defaultHome, env)) {
    entries.push({ kind: "home", label: path.resolve(instance.home), reason: `registered:${instance.name}` })
  }
  return entries
}

async function planWorktrees({ main, git, worktreesRoot, endpoint }) {
  const options = { worktreesRoot, minAgeMinutes: WORKTREE_MIN_AGE_MINUTES }
  const targets = []
  const spared = []
  const now = Date.now()
  for (const tree of listWorktrees(main, git)) {
    const candidate = { ...inspectWorktree(tree, { repo: main, git, now }), todoStatus: null }
    if (!candidate.dirty && candidate.ageMinutes >= options.minAgeMinutes) {
      candidate.todoStatus = await fetchTodoStatus(todoIdFromWorktree(tree), endpoint)
    }
    const verdict = classifyWorktree(candidate, options)
    const entry = { kind: "worktree", label: tree, reason: verdict.reason }
    ;(verdict.prune ? targets : spared).push(entry)
  }
  // `main` travels with the plan: `git worktree remove` has to be run from a
  // checkout that outlives the removal, and the caller's --repo may be one of
  // the trees about to go.
  return { targets, spared, main }
}

function render(plan, options) {
  const lines = [
    `Mode: ${options.apply ? "APPLY" : "DRY RUN (pass --apply to act)"}   Process age guard: >= ${options.minAgeMin} min   Worktree age guard: >= ${WORKTREE_MIN_AGE_MINUTES} min`,
    "",
  ]
  for (const target of plan.processes.targets) {
    lines.push(`  REAP   pid=${String(target.pid).padEnd(7)} ${target.kind.padEnd(19)} age=${target.ageMinutes}min  ${target.reason}`)
  }
  for (const target of plan.worktrees.targets) {
    lines.push(`  PRUNE  ${target.label}  ${target.reason}`)
  }
  if (plan.processes.targets.length + plan.worktrees.targets.length === 0) lines.push("  nothing to do")
  lines.push("", `Spared (${plan.spared.length}):`)
  for (const entry of plan.spared) lines.push(`  keep   ${entry.label.padEnd(48)} ${entry.reason}`)
  return `${lines.join("\n")}\n`
}

function signal(pid, name) {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone between planning and signalling, which is the outcome we wanted.
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function reapProcesses(targets, graceSeconds) {
  for (const target of targets) signal(target.pid, "SIGTERM")
  if (targets.length === 0) return 0
  await new Promise((resolve) => setTimeout(resolve, graceSeconds * 1000))
  for (const target of targets) {
    if (isAlive(target.pid)) signal(target.pid, "SIGKILL")
  }
  return targets.filter((target) => !isAlive(target.pid)).length
}

/**
 * Removal reads the tree's state again, because the plan was made before the
 * process grace wait and a run that wrote into its worktree in between must
 * still be preserved. No `--force`: git's own refusal to remove a tree that is
 * not clean is the second half of the same guarantee.
 */
function pruneWorktrees(targets, repo, git) {
  const removed = []
  const kept = []
  for (const target of targets) {
    const current = inspectWorktree(target.label, { repo, git, now: Date.now() })
    if (current.missing || current.dirty) {
      kept.push(target.label)
      continue
    }
    if (git(repo, ["worktree", "remove", target.label]) !== null) removed.push(target.label)
  }
  git(repo, ["worktree", "prune"])
  return { removed, kept }
}

/**
 * Worktrees are planned before processes because the process plan is decided
 * against them: a parentless test worker is only ours when it runs out of a
 * tree this same run is removing. Execution keeps the opposite order — kill the
 * worker, then remove the tree it was holding open.
 */
async function buildPlan(options, env, git) {
  const checkout = mainCheckout(options.repo, git)
  const worktrees = await planWorktrees({
    main: checkout,
    git,
    worktreesRoot: realPath(path.join(path.dirname(checkout), ".worktrees")),
    endpoint: gatewayEndpoint(resolveDefaultHome(env)),
  })
  const context = buildContext({
    env,
    minAgeMinutes: options.minAgeMin,
    selfPids: [process.pid, process.ppid],
    pruningWorktrees: worktrees.targets.map((target) => target.label),
  })
  const processes = planProcessReap(withWorkingDirectories(parsePsDump(psDump(env))), context)
  return {
    processes,
    worktrees,
    spared: [
      ...protectedHomeEntries(env),
      ...processes.spared.map((entry) => ({ ...entry, label: `pid=${entry.pid}` })),
      ...worktrees.spared,
    ],
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).join("\n"))
    return
  }
  const env = process.env
  const git = gitRunner(env)
  const plan = await buildPlan(options, env, git)
  const { processes, worktrees } = plan

  const report = options.json ? `${JSON.stringify(plan)}\n` : render(plan, options)
  process.stdout.write(report)
  if (options.log) fs.appendFileSync(options.log, `${new Date().toISOString()} ${JSON.stringify(plan)}\n`)
  if (!options.apply) {
    if (!options.json) process.stdout.write("\nDry run only. Re-run with --apply to act.\n")
    return
  }

  const reaped = await reapProcesses(processes.targets, options.graceSeconds)
  const pruned = pruneWorktrees(worktrees.targets, worktrees.main, git)
  if (!options.json) {
    for (const label of pruned.kept) process.stdout.write(`  keep   ${label}  changed since the plan was made\n`)
    process.stdout.write(`\nReaped ${reaped}/${processes.targets.length} process(es), removed ${pruned.removed.length}/${worktrees.targets.length} worktree(s).\n`)
  }
}

await main()
