import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { MOUNT_SENTINEL } from "../shared/remote-target.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { serializeOn, shq, sshRun, type SshRunResult } from "./remote-stage.js";

/** Default for `remote.mountWaitMs`: how long a turn waits for the mount to come up. */
export const DEFAULT_MOUNT_WAIT_MS = 120_000;
/** The engine's budget for one `remountCommand` run, whatever is left of the wait. */
const REMOUNT_TIMEOUT_MS = 60_000;
/** How long the remote side lets one sentinel read run. A live FUSE mount whose
 *  sshfs is still connecting blocks a `cat` on it indefinitely; that is "not
 *  ready yet", and must not cost a whole control budget to find out. */
const SENTINEL_READ_TIMEOUT_S = 5;
const SENTINEL_CONNECT_TIMEOUT_S = 15;
let sentinelReadTimeoutS = SENTINEL_READ_TIMEOUT_S;

/** Exported for tests: shorten the remote read timeout. `null` restores it. */
export function setSentinelReadTimeoutForTests(seconds: number | null): void {
  sentinelReadTimeoutS = seconds ?? SENTINEL_READ_TIMEOUT_S;
}

/**
 * Read the sentinel with a timeout enforced ON the remote, so a blocked read is
 * killed there rather than left hanging on the host. `timeout(1)` is not on
 * every host (macOS), hence the watchdog. Exit 124 means the read timed out.
 * The watchdog's output goes to /dev/null so it cannot hold the ssh channel open.
 */
const SENTINEL_READ_SCRIPT = `
f=$1; t=$2
cat "$f" 2>/dev/null &
p=$!
( sleep "$t"; kill -9 "$p" ) >/dev/null 2>&1 &
w=$!
wait "$p"; rc=$?
kill "$w" 2>/dev/null
[ "$rc" -gt 128 ] && exit 124
exit "$rc"
`;

type SentinelState = "ok" | "missing" | "mismatched" | "timed out";

/** Read (creating on first use) the gateway-side sentinel value.
 *  Its only job is to be a value the remote can only see THROUGH the mount. */
export function localSentinelValue(): string {
  const file = path.join(JINN_HOME, MOUNT_SENTINEL);
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch { /* first use */ }
  const value = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(JINN_HOME, { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

function sentinelState(res: SshRunResult, expected: string): SentinelState {
  // `null` is the local backstop firing: the remote watchdog itself never answered.
  if (res.code === null || res.code === 124) return "timed out";
  const seen = res.code === 0 ? res.stdout.trim() : "";
  if (seen === expected) return "ok";
  return seen ? "mismatched" : "missing";
}

async function readRemoteSentinel(destination: string, mount: string, expected: string): Promise<SentinelState> {
  const command = `sh -s ${shq(path.posix.join(mount, MOUNT_SENTINEL))} ${sentinelReadTimeoutS}`;
  const res = await sshRun(destination, [command], {
    stdin: SENTINEL_READ_SCRIPT,
    connectTimeoutSeconds: SENTINEL_CONNECT_TIMEOUT_S,
    timeoutMs: (sentinelReadTimeoutS + SENTINEL_CONNECT_TIMEOUT_S + 5) * 1000,
  });
  return sentinelState(res, expected);
}

async function runRemount(destination: string, command: string): Promise<void> {
  logger.info(`remote: mount on ${destination} is not live — running remountCommand`);
  const startedAt = Date.now();
  const res = await sshRun(destination, [command], { timeoutMs: REMOUNT_TIMEOUT_MS });
  const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  if (res.code === 0) {
    logger.info(`remote remountCommand on ${destination} finished in ${elapsed}`);
    return;
  }
  const outcome = res.code === null ? `was killed after ${elapsed} (no exit within ${REMOUNT_TIMEOUT_MS / 1000}s)` : `exited ${res.code} after ${elapsed}`;
  logger.warn(`remote remountCommand on ${destination} ${outcome}: ${res.stderr.trim() || "(no stderr)"}`);
}

/** How long, and how, {@link verifyMount} may wait. `waitMs: 0` checks once. */
export interface MountWait {
  waitMs: number;
  intervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  aborted: () => boolean;
}

function mountProblem(state: Exclude<SentinelState, "ok">, destination: string, remote: RemoteExecutionConfig, waitMs: number): string {
  const what = state === "timed out"
    ? `reading the sentinel timed out after ${sentinelReadTimeoutS}s, so the mount is hung or still connecting`
    : `sentinel ${state}`;
  const waited = waitMs > 0 && state !== "mismatched" ? ` after waiting ${Math.round(waitMs / 1000)}s` : "";
  return `the gateway's instance home is not mounted at ${remote.mount} on ${destination}${waited} `
    + `(${what}) — without it the session's writes to `
    + `knowledge/, docs/ and org/ would land on the remote host instead of reaching the org`;
}

async function pollMount(destination: string, remote: RemoteExecutionConfig, wait: MountWait): Promise<string | undefined> {
  const expected = localSentinelValue();
  const deadline = wait.now() + wait.waitMs;
  for (;;) {
    let state = await readRemoteSentinel(destination, remote.mount, expected);
    // A read that times out is a mount that is live but not answering yet;
    // remounting cannot hurry it, and a second sshfs on top would not help.
    if (state !== "ok" && state !== "timed out" && remote.remountCommand) {
      await runRemount(destination, remote.remountCommand);
      state = await readRemoteSentinel(destination, remote.mount, expected);
    }
    if (state === "ok") return undefined;
    // Some other directory's sentinel, after a remount if one is configured:
    // waiting will not change which directory is mounted there.
    if (state === "mismatched" || wait.now() >= deadline) return mountProblem(state, destination, remote, wait.waitMs);
    if (wait.aborted()) return "cancelled while waiting for the remote host's mount";
    await wait.sleep(wait.intervalMs);
    if (wait.aborted()) return "cancelled while waiting for the remote host's mount";
  }
}

const mountChecks = new Map<string, Promise<unknown>>();

/** Exported for tests: drop the per-host mount-check queue. */
export function clearRemoteMountQueue(): void {
  mountChecks.clear();
}

/**
 * Confirm the gateway's instance home is genuinely mounted on the remote host.
 *
 * The failure this exists for is a SILENTLY unmounted sshfs: the symlink farm
 * then points into an empty directory, the session's writes to knowledge/ and
 * docs/ succeed locally, and the org quietly diverges with no error anywhere.
 * A reboot does not bring sshfs back, so a host that just woke normally lands
 * here with a dead mount — which is why the remount attempt is on this path,
 * and why a turn may wait a bounded time for a mount that is still connecting.
 *
 * Only a sentinel that reads back as the gateway's own value passes; every
 * other outcome, a timeout included, refuses the spawn.
 *
 * Serialized per host, so turns starting together share one remount instead of
 * each running `remountCommand` against the same mountpoint.
 */
export async function verifyMount(destination: string, remote: RemoteExecutionConfig, wait: MountWait): Promise<string | undefined> {
  return await serializeOn(mountChecks, destination, () => pollMount(destination, remote, wait));
}
