import { spawn } from "node:child_process"

/**
 * A long-lived child that pretends to be a process the lab must reap, and that is guaranteed to die
 * with the test that made it.
 *
 * The fixture only exits on SIGTERM, and its IPC channel is a live handle on the TEST process. So an
 * early return — a failed assertion, or `node --test` cancelling the test at its timeout — used to
 * leave both alive, and the runner then could not exit. That is not hypothetical: it hung a release
 * for 38 minutes until the CI job budget ran out, with the runner terminating orphans afterwards.
 *
 * Everything here therefore runs the caller's body inside `try/finally` and reaps unconditionally:
 * disconnect the IPC handle first so the event loop is free even if the kill races, then SIGKILL if
 * the child has not already exited on its own.
 */
export async function withLabHomeFixture({ layout, source }, body) {
  const child = spawn(process.execPath, ["-e", source], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: layout.osHome, HUNDREDFOLD_HOME: layout.home },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  try {
    await new Promise((resolve, reject) => {
      child.once("message", resolve)
      child.once("error", reject)
      child.once("exit", (code, signal) => reject(new Error(`fixture exited early: ${code ?? signal}`)))
    })
    return await body(child)
  } finally {
    if (child.connected) child.disconnect()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
}
