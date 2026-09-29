import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PTY_SNAPSHOTS_DIR } from "../../shared/paths.js";
import { ptySnapshotStore } from "../../engines/pty-snapshot.js";
import type * as pty from "node-pty";
import type { PtyControlEvent } from "../../engines/pty-view-engine.js";
import type { TerminalHost } from "../hosts.js";
import { ShellTerminalEngine, terminalCommand, terminalEnv, type TerminalHostResolution } from "../shell-engine.js";

class FakePty {
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  constructor(public file: string, public args: string[], public opts: pty.IPtyForkOptions, public pid: number) {}
  get cols() { return this.opts.cols; }
  get rows() { return this.opts.rows; }
  onData(cb: (d: string) => void) { this.dataCbs.push(cb); return { dispose() {} }; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCbs.push(cb); return { dispose() {} }; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resized.push([cols, rows]); }
  kill() { this.killed = true; }
  emit(data: string) { for (const cb of this.dataCbs) cb(data); }
  exit(exitCode: number) { for (const cb of this.exitCbs) cb({ exitCode }); }
}

const local: TerminalHost = { id: "local", label: "pi", kind: "local" };
const remote: TerminalHost = { id: "build", label: "Build host", kind: "ssh", destination: "builder@10.0.0.5", cwd: "/srv/it's" };

function harness(opts: { resolve?: (id: string) => TerminalHostResolution; maxLive?: number } = {}) {
  const spawned: FakePty[] = [];
  const engine = new ShellTerminalEngine({
    resolveHost: opts.resolve ?? (() => ({ host: local })),
    settings: () => ({ maxLive: opts.maxLive }),
    env: { HOME: "/home/op", SHELL: "/bin/zsh", PATH: "/usr/bin", LC_ALL: "C.UTF-8", ANTHROPIC_API_KEY: "sk-secret", JINN_SESSION_ID: "abc" },
    spawn: ((file: string, args: string[] | string, o: pty.IPtyForkOptions) => {
      const p = new FakePty(file, args as string[], o, 1000 + spawned.length);
      spawned.push(p);
      return p as unknown as pty.IPty;
    }) as typeof pty.spawn,
  });
  return { engine, spawned };
}

describe("terminalEnv", () => {
  it("passes a login's environment and nothing the gateway was holding", () => {
    const env = terminalEnv({ HOME: "/h", PATH: "/bin", LC_CTYPE: "C", ANTHROPIC_API_KEY: "sk", JINN_HOME: "/j", GITHUB_TOKEN: "t" });
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", LC_CTYPE: "C", TERM: "xterm-256color", COLORTERM: "truecolor" });
  });
});

describe("terminalCommand", () => {
  it("runs a login shell for the gateway", () => {
    expect(terminalCommand(local, "/bin/zsh")).toEqual(["/bin/zsh", ["-l"]]);
  });

  it("wraps ssh in a banner, keeps the destination behind --, and quotes the cwd", () => {
    const [file, args] = terminalCommand(remote, "/bin/zsh");
    expect(file).toBe("/bin/sh");
    expect(args[0]).toBe("-c");
    // The label travels as $0, never inside the script.
    expect(args[1]).not.toContain("Build host");
    expect(args[2]).toBe("Build host");
    const ssh = args.slice(3);
    expect(ssh[0]).toMatch(/ssh$/);
    expect(ssh).toContain("-tt");
    expect(ssh.indexOf("--")).toBe(ssh.indexOf("builder@10.0.0.5") - 1);
    // Only POSIX sh parses the script (a fish or nu login shell would reject
    // it); the cwd travels as $1, quoted for the login shell's own parse.
    expect(ssh.at(-1)).toBe(`exec /bin/sh -c 'cd "$1" 2>/dev/null || cd; exec "\${SHELL:-/bin/sh}" -l' sh '/srv/it'\\''s'`);
  });

  it("opens a plain login on an ssh host with no cwd", () => {
    const [, args] = terminalCommand({ ...remote, cwd: undefined }, "/bin/sh");
    expect(args.at(-1)).toBe("builder@10.0.0.5");
  });
});

describe("ShellTerminalEngine", () => {
  it("spawns once, at the viewer's geometry, in the operator's home with a clean env", () => {
    const { engine, spawned } = harness();
    engine.ensureIdleSpawn("t1", { cols: 90, rows: 30 });
    engine.ensureIdleSpawn("t1", { cols: 90, rows: 30 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).toBe("/bin/zsh");
    expect(spawned[0].opts).toMatchObject({ cols: 90, rows: 30, cwd: "/home/op" });
    expect(spawned[0].opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spawned[0].opts.env).not.toHaveProperty("JINN_SESSION_ID");
    expect(engine.hasWarmPty("t1")).toBe(true);
  });

  it("writes input and resizes the live shell only", () => {
    const { engine, spawned } = harness();
    engine.writeRaw("t1", "ls\r");
    engine.ensureIdleSpawn("t1", {});
    engine.writeRaw("t1", "ls\r");
    engine.writeStdin("t1", "pwd");
    engine.resizePty("t1", 100, 20);
    expect(spawned[0].written).toEqual(["ls\r", "pwd"]);
    expect(spawned[0].resized).toEqual([[100, 20]]);
  });

  it("refuses to spawn when the host no longer resolves", () => {
    const { engine, spawned } = harness({ resolve: () => ({ error: "Terminal host \"x\" is no longer configured." }) });
    expect(() => engine.ensureIdleSpawn("t1", {})).toThrow(/no longer configured/);
    expect(spawned).toHaveLength(0);
  });

  it("caps live shells across every session", () => {
    const { engine } = harness({ maxLive: 2 });
    engine.ensureIdleSpawn("a", {});
    engine.ensureIdleSpawn("b", {});
    expect(() => engine.ensureIdleSpawn("c", {})).toThrow(/terminal\.maxLive is 2/);
    engine.forget("a");
    expect(() => engine.ensureIdleSpawn("c", {})).not.toThrow();
  });

  it("streams output to a subscriber and reports the exit", async () => {
    const { engine, spawned } = harness();
    const controls: PtyControlEvent[] = [];
    const data: string[] = [];
    const sub = engine.subscribeWithSnapshot("t1", (d) => data.push(d.toString()), (e) => controls.push(e));
    await sub.snapshot;
    sub.start();
    engine.ensureIdleSpawn("t1", { cols: 80, rows: 24 });
    spawned[0].emit("op@pi:~$ ");
    await vi_waitFor(() => controls.some((c) => c.type === "ready"));
    expect(controls.map((c) => c.type)).toContain("snapshot");
    spawned[0].emit("more");
    expect(data.join("")).toContain("more");
    spawned[0].exit(0);
    expect(controls.at(-1)).toEqual({ type: "exited", exitCode: 0, signal: 0 });
    expect(engine.hasWarmPty("t1")).toBe(false);
  });

  it("keeps an exited shell down until an explicit restart", () => {
    const { engine, spawned } = harness();
    engine.ensureIdleSpawn("t1", {});
    spawned[0].exit(0);
    engine.ensureIdleSpawn("t1", { cols: 101, rows: 30 });
    expect(spawned).toHaveLength(1);
    expect(engine.exitNotice("t1")).toEqual({ type: "exited", exitCode: 0, signal: 0 });
    engine.restartPty("t1", {});
    expect(spawned).toHaveLength(2);
    expect(engine.exitNotice("t1")).toBeUndefined();
  });

  it("stays exited when a restart cannot start a new shell", () => {
    const { engine, spawned } = harness({ maxLive: 1 });
    engine.ensureIdleSpawn("a", {});
    spawned[0].exit(0);
    engine.ensureIdleSpawn("b", {});
    expect(() => engine.restartPty("a", {})).toThrow(/terminal\.maxLive is 1/);
    expect(engine.exitNotice("a")).toEqual({ type: "exited", exitCode: 0, signal: 0 });
    engine.ensureIdleSpawn("a", { cols: 90, rows: 20 });
    expect(spawned).toHaveLength(2);
  });

  it("never writes a terminal's screen to disk, and forgets it on delete", async () => {
    const { engine, spawned } = harness();
    const controls: PtyControlEvent[] = [];
    const sub = engine.subscribeWithSnapshot("t-secret", () => {}, (e) => controls.push(e));
    sub.start();
    engine.ensureIdleSpawn("t-secret", { cols: 80, rows: 24 });
    spawned[0].emit("SECRET_TOKEN_abc123\r\n$ ");
    await vi_waitFor(() => controls.some((c) => c.type === "ready"));
    // Force out anything the process-wide disk store has pending for this
    // session; with the engine wired to it, this is what would write the file.
    await ptySnapshotStore.flush("t-secret");
    // The disk store names a file by sha256(sessionId); look for that file and,
    // belt and braces, for the secret in anything under the snapshot directory.
    const diskFile = path.join(PTY_SNAPSHOTS_DIR, `${createHash("sha256").update("t-secret").digest("hex")}.json`);
    expect(fs.existsSync(diskFile)).toBe(false);
    const onDisk = fs.existsSync(PTY_SNAPSHOTS_DIR)
      ? fs.readdirSync(PTY_SNAPSHOTS_DIR).map((f) => fs.readFileSync(path.join(PTY_SNAPSHOTS_DIR, f), "utf8")).join("\n")
      : "";
    expect(onDisk).not.toContain("SECRET_TOKEN_abc123");
    const kept = await engine.subscribeWithSnapshot("t-secret", () => {}).snapshot;
    expect(kept.snapshot?.data).toContain("SECRET_TOKEN_abc123");
    engine.forget("t-secret");
    expect(spawned[0].killed).toBe(true);
    const after = await engine.subscribeWithSnapshot("t-secret", () => {}).snapshot;
    expect(after.snapshot).toBeUndefined();
  });

  it("tells a still-subscribed viewer the terminal was deleted, not-recoverably", async () => {
    // A second tab/device can still be subscribed to this stream when the
    // session is deleted from elsewhere. Without an explicit notice its next
    // resize used to fail with a bare "Not a terminal session." error.
    const { engine, spawned } = harness();
    const controls: PtyControlEvent[] = [];
    const sub = engine.subscribeWithSnapshot("t1", () => {}, (e) => controls.push(e));
    sub.start();
    engine.ensureIdleSpawn("t1", { cols: 80, rows: 24 });
    engine.forget("t1");
    expect(spawned[0].killed).toBe(true);
    expect(controls.at(-1)).toEqual({
      type: "error",
      message: "This terminal was deleted.",
      recoverable: false,
    });
  });

  it("restarts into a fresh shell without announcing the old one's exit, ignoring its late exit", () => {
    const { engine, spawned } = harness();
    const controls: PtyControlEvent[] = [];
    const sub = engine.subscribeWithSnapshot("t1", () => {}, (e) => controls.push(e));
    sub.start();
    engine.ensureIdleSpawn("t1", {});
    engine.restartPty("t1", {});
    expect(spawned).toHaveLength(2);
    expect(spawned[0].killed).toBe(true);
    expect(controls.some((c) => c.type === "exited")).toBe(false);
    spawned[0].exit(129);
    expect(engine.hasWarmPty("t1")).toBe(true);
  });

  it("kills every shell on shutdown", () => {
    const { engine, spawned } = harness();
    engine.ensureIdleSpawn("a", {});
    engine.ensureIdleSpawn("b", {});
    engine.killAll();
    expect(spawned.every((p) => p.killed)).toBe(true);
    expect(engine.liveCount()).toBe(0);
  });
});

async function vi_waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
