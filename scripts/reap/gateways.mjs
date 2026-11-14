// Which running processes a sweep may signal, and why.
//
// The rule that shapes everything here: a gateway is identified by the
// `gateway.json` that claims its PID, never by its age, its name, or a path that
// looks like a sandbox. Two PIDs that read exactly like 2-day-old strays turned
// out to be live instance gateways, so a PID nothing claims is spared rather
// than reaped. Unidentified means untouchable.
import path from "node:path"

const GATEWAY_ENTRY = /packages\/(?:hundredfold|jinn)\/dist\/src\/gateway\// // rename:keep: a checkout from before the rename
const TEST_WORKER = /\b(?:vitest|jest|mocha)\b/

// A home is throwaway when it sits under a temp root, or when its own name says
// so. Both halves are needed: the upgrade lab builds homes under the temp dir,
// while a sandbox run can be pointed anywhere.
const THROWAWAY_NAME = /^\.?(?:hundredfold-sandbox|jinn-sandbox|jinn-home|upgrade-lab|hundredfold-upgrade-lab|jinn-upgrade-lab)-/ // rename:keep

// Below this, a PID belongs to the system rather than to anything we started.
const LOWEST_SIGNALLABLE_PID = 500

/** `ps -eo pid=,ppid=,etime=,rss=,args=` — four numeric columns, then the whole command line. */
export function parsePsDump(text) {
  const processes = []
  for (const line of text.split("\n")) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!fields) continue
    processes.push({
      pid: Number(fields[1]),
      ppid: Number(fields[2]),
      ageMinutes: etimeToMinutes(fields[3]),
      rssKiB: Number(fields[4]),
      args: fields[5],
    })
  }
  return processes
}

/** `dd-hh:mm:ss`, `hh:mm:ss` or `mm:ss` as whole minutes, rounding a half-minute up. */
export function etimeToMinutes(etime) {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime]
  const parts = clock.split(":").map(Number)
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1] ?? 0]
  return Number(days) * 1440 + hours * 60 + minutes + (seconds >= 30 ? 1 : 0)
}

export function isGatewayProcess(args) {
  return GATEWAY_ENTRY.test(args)
}

export function isThrowawayHome(home, throwawayRoots) {
  if (throwawayRoots.some((root) => isInside(home, root))) return true
  return THROWAWAY_NAME.test(path.basename(home))
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * The reason a PID may never be signalled, whatever else is true about it, or
 * null when none applies. Shared by gateways and by the children swept with
 * them, so a protected PID cannot slip in as somebody's child.
 */
function untouchableReason(pid, context) {
  if (pid < LOWEST_SIGNALLABLE_PID) return "system-pid"
  if (context.selfPids.includes(pid)) return "self"
  if (context.protectedPortPids.includes(pid)) return "protected-port"
  const home = context.homeByPid[pid]
  if (!home) return null
  if (home === context.defaultHome || isInside(home, context.defaultHome)) return "default-home"
  if (context.registeredHomes.includes(home)) return "registered-instance"
  return null
}

/** @returns {{ reap: boolean, reason: string }} */
export function classifyGateway(candidate, context) {
  const untouchable = untouchableReason(candidate.pid, context)
  if (untouchable) return { reap: false, reason: untouchable }
  const home = context.homeByPid[candidate.pid]
  if (!home) return { reap: false, reason: "unidentified" }
  if (!isThrowawayHome(home, context.throwawayRoots)) return { reap: false, reason: "home-not-throwaway" }
  if (candidate.ageMinutes < context.minAgeMinutes) return { reap: false, reason: "too-young" }
  return { reap: true, reason: "throwaway-home" }
}

/** A parentless test runner: necessary for orphan ownership, never sufficient. */
function isParentlessWorker(candidate) {
  return candidate.ppid === 1 && TEST_WORKER.test(candidate.args)
}

/** The PIDs whose ownership a working directory can settle, for a caller that can read one. */
export function parentlessWorkerPids(processes) {
  return processes.filter(isParentlessWorker).map((candidate) => candidate.pid)
}

/**
 * A worker orphaned by a killed run. It has no `gateway.json` to claim it, so
 * the one thing that can claim it is where the kernel says it is running: a
 * working directory inside a worktree this same sweep is deleting — a tree git
 * listed and the plan already resolved to remove, not a path that reads like
 * one. What a process calls itself proves nothing about where it belongs, so a
 * worker whose directory could not be read stays unclaimed. An operator's own
 * `vitest --watch` reparents to PID 1 the moment its shell closes, and unproven
 * has to mean untouched.
 */
function isOrphanedTestWorker(candidate, context) {
  if (!isParentlessWorker(candidate)) return false
  if (!candidate.cwd) return false
  const runningIn = path.resolve(candidate.cwd)
  const owned = (context.pruningWorktrees ?? []).some(
    (tree) => runningIn === path.resolve(tree) || isInside(runningIn, tree),
  )
  if (!owned) return false
  if (untouchableReason(candidate.pid, context)) return false
  return candidate.ageMinutes >= context.minAgeMinutes
}

/**
 * @returns {{ targets: Array<{pid: number, kind: string, reason: string, ageMinutes: number, args: string}>,
 *             spared: Array<{pid: number, kind: string, reason: string}> }}
 */
export function planProcessReap(processes, context) {
  const targets = []
  const spared = []
  const reapedGateways = new Set()

  for (const candidate of processes) {
    if (!isGatewayProcess(candidate.args)) continue
    const verdict = classifyGateway(candidate, context)
    if (!verdict.reap) {
      spared.push({ pid: candidate.pid, kind: "gateway", reason: verdict.reason })
      continue
    }
    reapedGateways.add(candidate.pid)
    targets.push({ ...candidate, kind: "sandbox-gateway", reason: verdict.reason })
  }

  for (const candidate of processes) {
    if (isGatewayProcess(candidate.args)) continue
    if (reapedGateways.has(candidate.ppid) && !untouchableReason(candidate.pid, context)) {
      targets.push({ ...candidate, kind: "gateway-child", reason: `child-of-${candidate.ppid}` })
    } else if (isOrphanedTestWorker(candidate, context)) {
      targets.push({ ...candidate, kind: "orphan-test-worker", reason: "orphaned" })
    }
  }

  targets.sort((left, right) => left.pid - right.pid)
  return { targets, spared }
}
