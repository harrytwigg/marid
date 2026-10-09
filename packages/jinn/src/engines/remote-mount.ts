import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { MOUNT_SENTINEL } from "../shared/remote-target.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { shq, sshRun, type SshRunResult } from "./remote-stage.js";

/** Default for `remote.mountWaitMs`: how long a turn waits for the mount to come up. */
export const DEFAULT_MOUNT_WAIT_MS = 120_000;
/** The engine's budget for one `remountCommand` run. */
const REMOUNT_TIMEOUT_MS = 60_000;
/** The least a remount gets near the end of a wait, so it can still finish. */
const MIN_REMOUNT_TIMEOUT_MS = 15_000;
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

async function runRemount(destination: string, command: string, timeoutMs: number): Promise<void> {
  logger.info(`remote: mount on ${destination} is not live — running remountCommand`);
  const startedAt = Date.now();
  const res = await sshRun(destination, [command], { timeoutMs });
  const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  if (res.code === 0) {
    logger.info(`remote remountCommand on ${destination} finished in ${elapsed}`);
    return;
  }
  const outcome = res.code === null ? `was killed after ${elapsed} (no exit within ${Math.round(timeoutMs / 1000)}s)` : `exited ${res.code} after ${elapsed}`;
  logger.warn(`remote remountCommand on ${destination} ${outcome}: ${res.stderr.trim() || "(no stderr)"}`);
}

/** How long, and how, {@link verifyMount} may wait. `waitMs: 0` checks once. */
export interface MountWait {
  waitMs: number;
  intervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called once when a wait begins: the first check that fails, with `waitMs` above 0. */
  onWaitStart: () => void;
  aborted: () => boolean;
}

/** One poll of one host, and what it has found so far. */
interface MountPoll {
  destination: string;
  remote: RemoteExecutionConfig;
  wait: MountWait;
  expected: string;
  deadline: number;
}

const CANCELLED = "cancelled while waiting for the remote host's mount";

function mountProblem(poll: MountPoll, state: Exclude<SentinelState, "ok">, remountedHung: boolean): string {
  const what = state === "timed out"
    ? `reading the sentinel timed out after ${sentinelReadTimeoutS}s, so the mount is hung or still connecting`
      + (remountedHung ? "; remountCommand did not clear it" : "")
    : `sentinel ${state}`;
  const { waitMs } = poll.wait;
  const waited = waitMs > 0 && state !== "mismatched" ? ` after waiting ${Math.round(waitMs / 1000)}s` : "";
  return `the gateway's instance home is not mounted at ${poll.remote.mount} on ${poll.destination}${waited} `
    + `(${what}) — without it the session's writes to `
    + `knowledge/, docs/ and org/ would land on the remote host instead of reaching the org`;
}

/** Run `remountCommand`, then read again. Within a wait it gets what is left of
 *  the budget, between {@link MIN_REMOUNT_TIMEOUT_MS} and the usual 60s. */
async function remountAndRead(poll: MountPoll): Promise<SentinelState> {
  const { destination, remote, wait } = poll;
  const left = poll.deadline - wait.now();
  const timeoutMs = wait.waitMs > 0 ? Math.min(REMOUNT_TIMEOUT_MS, Math.max(left, MIN_REMOUNT_TIMEOUT_MS)) : REMOUNT_TIMEOUT_MS;
  await runRemount(destination, remote.remountCommand!, timeoutMs);
  return await readRemoteSentinel(destination, remote.mount, poll.expected);
}

/** One check: read, and remount when the mount is absent. A read that times out
 *  is a mount that is live but not answering yet; remounting cannot hurry it,
 *  and a second sshfs on top would not help, so that waits. */
async function checkOnce(poll: MountPoll, announce: () => void): Promise<SentinelState> {
  const state = await readRemoteSentinel(poll.destination, poll.remote.mount, poll.expected);
  if (state === "ok") return state;
  announce();
  if (state === "timed out" || !poll.remote.remountCommand) return state;
  return await remountAndRead(poll);
}

/** The budget is spent. A mount that hung the whole time gets one remount,
 *  so a `remountCommand` that clears a dead mount first can still heal it. */
async function lastChance(poll: MountPoll, state: Exclude<SentinelState, "ok">): Promise<string | undefined> {
  if (state !== "timed out" || !poll.remote.remountCommand) return mountProblem(poll, state, false);
  const after = await remountAndRead(poll);
  return after === "ok" ? undefined : mountProblem(poll, after, after === "timed out");
}

async function pollMount(destination: string, remote: RemoteExecutionConfig, wait: MountWait): Promise<string | undefined> {
  const poll: MountPoll = { destination, remote, wait, expected: localSentinelValue(), deadline: wait.now() + wait.waitMs };
  let announced = false;
  // Announced before any remount, so the turn reads as waiting through it.
  const announce = () => {
    if (announced || wait.waitMs <= 0) return;
    announced = true;
    wait.onWaitStart();
  };
  for (;;) {
    const state = await checkOnce(poll, announce);
    if (state === "ok") return undefined;
    // Some other directory's sentinel, after a remount if one is configured:
    // waiting will not change which directory is mounted there.
    if (state === "mismatched") return mountProblem(poll, state, false);
    if (wait.now() >= poll.deadline) return await lastChance(poll, state);
    if (wait.aborted()) return CANCELLED;
    await wait.sleep(wait.intervalMs);
    if (wait.aborted()) return CANCELLED;
  }
}

/** A poll in flight on one host, and everyone waiting on its answer. */
interface SharedPoll {
  waits: boolean;
  waiters: MountWait[];
  announced: boolean;
  result: Promise<string | undefined>;
}

const inFlight = new Map<string, SharedPoll>();

/** Exported for tests: forget polls in flight. */
export function clearRemoteMountQueue(): void {
  inFlight.clear();
}

function joinPoll(shared: SharedPoll, wait: MountWait): void {
  shared.waiters.push(wait);
  if (shared.announced) wait.onWaitStart();
}

/** Start a poll that later callers on the same host join. It is abandoned only
 *  when every caller on it has been stopped. */
function startPoll(destination: string, remote: RemoteExecutionConfig, wait: MountWait): Promise<string | undefined> {
  const shared: SharedPoll = { waits: wait.waitMs > 0, waiters: [wait], announced: false, result: Promise.resolve(undefined) };
  const run: MountWait = {
    ...wait,
    onWaitStart: () => {
      shared.announced = true;
      for (const w of shared.waiters) w.onWaitStart();
    },
    aborted: () => shared.waiters.every((w) => w.aborted()),
  };
  shared.result = pollMount(destination, remote, run).finally(() => {
    if (inFlight.get(destination) === shared) inFlight.delete(destination);
  });
  inFlight.set(destination, shared);
  return shared.result;
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
 * A caller that arrives while a check is in flight on the same host takes that
 * check's answer, so turns starting together share one remount and one wait
 * rather than each running `remountCommand` or queueing for a full wait of its
 * own. A single check that failed says nothing about what waiting would find,
 * so a caller prepared to wait then polls for itself.
 */
export async function verifyMount(destination: string, remote: RemoteExecutionConfig, wait: MountWait): Promise<string | undefined> {
  for (;;) {
    const shared = inFlight.get(destination);
    if (!shared) return await startPoll(destination, remote, wait);
    joinPoll(shared, wait);
    const problem = await shared.result;
    if (!problem || shared.waits || wait.waitMs <= 0) return problem;
  }
}
