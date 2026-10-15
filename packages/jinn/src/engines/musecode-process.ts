import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../shared/logger.js";
import { MspClient } from "./musecode-msp.js";

const STDERR_MAX = 10 * 1024;
/** How long after a child exits its pipes get to close on their own. */
const STDIO_SETTLE_MS = 500;

export interface MspProcessSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface MspProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** How long a child gets to leave on its own once stdin is closed, then after SIGTERM. */
export const MSP_EXIT_GRACE_MS = 2000;

/**
 * One MSP host process and the client talking to it.
 *
 * Shutdown is stdin first (that is the protocol's own way out), then SIGTERM
 * after a short grace, then SIGKILL. The child leads its own process group so
 * the signals reach whatever it spawned (MCP servers, shells).
 */
export class MspProcess {
  readonly client: MspClient;
  private readonly proc: ChildProcess;
  private stderr = "";
  private exit: MspProcessExit | undefined;
  private readonly exited: Promise<MspProcessExit>;
  private spawnError: Error | undefined;

  constructor(spec: MspProcessSpec) {
    this.proc = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.client = new MspClient(this.proc.stdin!, this.proc.stdout!);
    this.proc.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      this.stderr = (this.stderr + chunk).slice(-STDERR_MAX);
      for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[muse stderr] ${l}`);
    });
    this.exited = new Promise<MspProcessExit>((resolve) => {
      this.proc.once("error", (err) => {
        this.spawnError = err;
        this.exit = { code: null, signal: null };
        this.client.close(`failed to spawn ${spec.bin}: ${err.message}`);
        resolve(this.exit);
      });
      // `exit` is the child going, `close` is its pipes closing too. Something it left running (a
      // daemonised tool, say) can hold them open indefinitely, so the exit does not wait on them past
      // a short settle for the child's last words.
      this.proc.once("exit", (code, signal) => {
        this.exit = { code, signal };
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(settle);
          for (const stream of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) stream?.destroy();
          this.client.close(`${spec.bin} exited (code ${code ?? "none"}${signal ? `, signal ${signal}` : ""})`);
          resolve(this.exit!);
        };
        const settle = setTimeout(finish, STDIO_SETTLE_MS);
        settle.unref?.();
        this.proc.once("close", finish);
      });
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** Set when the binary could not be spawned at all. */
  get failedToSpawn(): Error | undefined {
    return this.spawnError;
  }

  /** The last of the child's stderr, for an error message. */
  get stderrTail(): string {
    return this.stderr.trim();
  }

  get hasExited(): boolean {
    return this.exit !== undefined;
  }

  waitForExit(): Promise<MspProcessExit> {
    return this.exited;
  }

  /** Close stdin and wait for the child to go; SIGTERM, then SIGKILL, if it will not. */
  async shutdown(graceMs: number = MSP_EXIT_GRACE_MS): Promise<MspProcessExit> {
    this.client.end();
    const first = await this.raceExit(graceMs);
    if (first) return first;
    this.signal("SIGTERM");
    const second = await this.raceExit(graceMs);
    if (second) return second;
    this.signal("SIGKILL");
    return await this.exited;
  }

  /** Signal the process group (SIGTERM by default). */
  signal(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.exit) return;
    try {
      if (process.platform !== "win32" && this.proc.pid) process.kill(-this.proc.pid, signal);
      else this.proc.kill(signal);
    } catch (err) {
      logger.debug(`Failed to send ${signal} to muse process: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async raceExit(ms: number): Promise<MspProcessExit | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exited, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
