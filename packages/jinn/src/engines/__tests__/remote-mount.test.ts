import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * The mount check before a remote spawn. A freshly booted host answers ssh
 * before its sshfs has connected, and while sshfs is connecting the mountpoint
 * is already a live FUSE mount on which a read blocks. The check used to look
 * once, spend a whole control budget on that blocked read and fail the turn as
 * "unreadable"; now a turn waits a bounded time, a blocked read is cut short on
 * the host, and the reason says which of timed out / missing / mismatched it was.
 *
 * `ssh` is replaced by a local `sh` that runs the remote command, so the real
 * sentinel read and remount run against a temporary directory standing in for
 * the mount. A FIFO stands in for the hung mount: `cat` on it blocks the same way.
 */

const hoisted = vi.hoisted(() => ({ facts: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      const remote = args.slice(args.indexOf("--") + 2).join(" ");
      // The facts script travels as `sh -s` with the script on stdin.
      if (remote === "sh -s") return actual.spawn("sh", ["-c", `cat >/dev/null; printf '%s' '${hoisted.facts}'`], options);
      return actual.spawn("sh", ["-c", remote], options);
    }) as typeof actual.spawn,
  };
});

const { ensureRemoteReady, clearRemoteFactsCache, clearRemoteStagingCache } = await import("../remote-stage.js");
const { localSentinelValue, setSentinelReadTimeoutForTests } = await import("../remote-mount.js");
const { employeeRemoteTarget } = await import("../../shared/remote-target.js");
const { getPackageVersion } = await import("../../shared/version.js");

let tmp: string;
let mount: string;
let sentinel: string;
let remounts: string;
let remote: RemoteExecutionConfig;
let clock: number;
let sleeps: number;
let onSleep: (n: number) => void;

function target() {
  return employeeRemoteTarget({
    name: "remote-dev", displayName: "Remote Dev", department: "engineering", rank: "employee", engine: "claude",
    model: "opus", persona: "p", remoteHost: "box", remoteCwd: path.join(tmp, "root", "work"),
  } as Employee, { remoteRoot: remote.root, departmentOf: () => null })!;
}

function ready(opts: { waitForMount?: boolean; shouldAbort?: () => boolean } = { waitForMount: true }) {
  return ensureRemoteReady(target(), remote, {
    engine: "claude",
    allowWake: true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleeps += 1;
      onSleep(sleeps);
    },
    ...opts,
  });
}

const mountIt = () => {
  fs.rmSync(sentinel, { force: true });
  fs.writeFileSync(sentinel, `${localSentinelValue()}\n`);
};
const hangIt = () => execFileSync("mkfifo", [sentinel], { stdio: "ignore" });
const remountCount = () => (fs.existsSync(remounts) ? fs.readFileSync(remounts, "utf-8").split("\n").filter(Boolean).length : 0);
const reasonOf = (r: Awaited<ReturnType<typeof ready>>) => (r.ready ? "" : r.reason);

beforeEach(() => {
  clearRemoteFactsCache();
  clearRemoteStagingCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-mount-")));
  const host = path.join(tmp, "host");
  mount = path.join(tmp, "mount");
  sentinel = path.join(mount, ".jinn-mount-sentinel");
  remounts = path.join(tmp, "remounts");
  fs.mkdirSync(mount, { recursive: true });
  fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
  remote = { root: path.join(tmp, "root"), mount, mountWaitMs: 60_000, probeIntervalMs: 5_000 } as RemoteExecutionConfig;
  hoisted.facts = [
    `home=${host}`, `node=${process.execPath}`, `claude=${path.join(host, "claude")}`,
    `jinnversion=${getPackageVersion()}`, `entrydir=${path.join(host, "entry")}`, "",
  ].join("\n");
  clock = 0;
  sleeps = 0;
  onSleep = () => {};
  setSentinelReadTimeoutForTests(1);
});

afterEach(() => {
  setSentinelReadTimeoutForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("the remote mount check", { timeout: 30_000 }, () => {
  it("waits for a mount that comes up a few polls later", async () => {
    onSleep = (n) => { if (n === 3) mountIt(); };
    const readiness = await ready();
    expect(reasonOf(readiness)).toBe("");
    expect(readiness.ready).toBe(true);
    expect(sleeps).toBe(3);
    expect(clock).toBeLessThanOrEqual(60_000);
  });

  it("gives up once mountWaitMs is spent, saying the sentinel is missing", async () => {
    const readiness = await ready();
    expect(readiness.ready).toBe(false);
    expect(reasonOf(readiness)).toContain(`not mounted at ${mount} on box after waiting 60s (sentinel missing)`);
    expect(clock).toBe(60_000);
  });

  it("checks once when the caller does not wait for the mount", async () => {
    const readiness = await ready({});
    expect(reasonOf(readiness)).toContain("(sentinel missing)");
    expect(sleeps).toBe(0);
  });

  it("cuts a hung read short on the host and keeps polling", async () => {
    hangIt();
    onSleep = (n) => { if (n === 1) mountIt(); };
    const startedAt = Date.now();
    const readiness = await ready();
    expect(readiness.ready).toBe(true);
    expect(sleeps).toBe(1);
    // One 1s remote read timeout, far inside the 60s control budget.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("reports a mount that stays hung as timed out, without remounting over it", async () => {
    hangIt();
    remote = { ...remote, mountWaitMs: 10_000, remountCommand: `echo run >> '${remounts}'` };
    const readiness = await ready();
    expect(reasonOf(readiness)).toContain("reading the sentinel timed out after 1s, so the mount is hung or still connecting");
    expect(reasonOf(readiness)).not.toContain("unreadable");
    expect(remountCount()).toBe(0);
    // Reads at 0, 5s and 10s.
    expect(sleeps).toBe(2);
  });

  it("refuses some other directory's sentinel after one remount, without waiting", async () => {
    fs.writeFileSync(sentinel, "not-this-gateway\n");
    remote = { ...remote, remountCommand: `echo run >> '${remounts}'` };
    const readiness = await ready();
    expect(reasonOf(readiness)).toContain("(sentinel mismatched)");
    expect(remountCount()).toBe(1);
    expect(sleeps).toBe(0);
  });

  it("remounts and passes when remountCommand brings the mount up", async () => {
    const source = path.join(tmp, "sentinel-source");
    fs.writeFileSync(source, `${localSentinelValue()}\n`);
    remote = { ...remote, remountCommand: `echo run >> '${remounts}'; cp '${source}' '${sentinel}'` };
    const readiness = await ready();
    expect(readiness.ready).toBe(true);
    expect(remountCount()).toBe(1);
  });

  it("runs remountCommand once for two turns starting together on one host", async () => {
    const source = path.join(tmp, "sentinel-source");
    fs.writeFileSync(source, `${localSentinelValue()}\n`);
    remote = { ...remote, remountCommand: `echo run >> '${remounts}'; sleep 1; cp '${source}' '${sentinel}'` };
    const [a, b] = await Promise.all([ready(), ready()]);
    expect([a.ready, b.ready]).toEqual([true, true]);
    expect(remountCount()).toBe(1);
  });

  it("does not take an unannounced mount wait for a stopped session", async () => {
    // The turn path's abort test reads the `waiting` status that only the
    // host-offline announcement sets; a reachable host never announces.
    onSleep = (n) => { if (n === 2) mountIt(); };
    const readiness = await ready({ waitForMount: true, shouldAbort: () => true });
    expect(readiness.ready).toBe(true);
  });
});
