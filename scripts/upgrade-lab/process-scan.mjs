import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

/**
 * Finding the lab's own processes, and nothing else.
 *
 * This is the reader that every reap depends on: `quiesceLabProcesses` will only signal a PID this
 * module reported. So the failure that matters is not a crash, it is an EMPTY answer — "nothing of
 * mine is running" is exactly what lets cleanup proceed, and a scan that cannot see process
 * environments returns precisely that. Hence no fallback invocation: it throws instead.
 */

const resolvedIdentity = (value) => {
  const absolute = path.resolve(value)
  try { return fs.realpathSync(absolute) } catch { return absolute }
}

export function buildLabProcessScanPipeline(labHome) {
  const expected = resolvedIdentity(labHome)
  return {
    source: {
      command: "ps",
      // `axeww` is one BSD bundle (all users, no-tty, show environment, wide). Written as `-axo` it
      // mixes BSD selectors with a UNIX flag: macOS tolerates it, procps rejects the command with
      // "must set personality to get -x option", so the scan threw instead of listing. No fallback
      // form is offered — the environment is what identifies a lab process, and a form that cannot
      // show it reports an empty table, which reads as "nothing of mine is running" and lets
      // cleanup proceed.
      args: ["axeww", "-o", "pid=,command="],
    },
    filter: {
      command: "awk",
      args: [
        "-v",
        `needle=HUNDREDFOLD_HOME=${expected}`,
        '{ for (i = 2; i <= NF; i++) if ($i == needle) { print $1; break } }',
      ],
    },
  }
}

async function runLabProcessScanPipeline(pipeline, spawnProcess = spawn) {
  const source = spawnProcess(pipeline.source.command, pipeline.source.args, { stdio: ["ignore", "pipe", "pipe"] })
  const filter = spawnProcess(pipeline.filter.command, pipeline.filter.args, { stdio: ["pipe", "pipe", "pipe"] })
  source.stdout.pipe(filter.stdin)

  const settle = (child) => {
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    return new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal, stderr }))
    })
  }
  let stdout = ""
  filter.stdout.setEncoding("utf8")
  filter.stdout.on("data", (chunk) => { stdout += chunk })
  const [sourceResult, filterResult] = await Promise.all([settle(source), settle(filter)])
  if (sourceResult.code !== 0) {
    throw new Error(`Unable to inspect lab processes: ${sourceResult.stderr.trim() || sourceResult.signal || sourceResult.code}`)
  }
  if (filterResult.code !== 0) {
    throw new Error(`Unable to filter lab processes: ${filterResult.stderr.trim() || filterResult.signal || filterResult.code}`)
  }
  return {
    stdout,
    scannerPids: [source.pid, filter.pid].filter(Number.isInteger),
  }
}

export async function listLabHomeProcessIds(labHome, dependencies = {}) {
  const pipeline = buildLabProcessScanPipeline(labHome)
  const run = dependencies.runLabProcessScanPipeline ?? runLabProcessScanPipeline
  const result = await run(pipeline)
  const output = typeof result === "string" ? result : result.stdout
  const scannerPids = new Set(typeof result === "string" ? [] : result.scannerPids)
  const pids = output
    .split(/\s+/)
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((pid) => pid !== process.pid && !scannerPids.has(pid))
  return [...new Set(pids)]
}
