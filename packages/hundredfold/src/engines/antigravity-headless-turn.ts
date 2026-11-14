import type { ChildProcess } from "node:child_process";
import type { EngineRunOpts, EngineResult } from "../shared/types.js";
import { killProcessTree } from "../shared/windows-spawn.js";
import {
  ANTIGRAVITY_TURN_TIMEOUT_MS,
  parseAntigravityStreamLine,
  type AntigravityParsedLine,
} from "./antigravity-headless-protocol.js";
import { readAntigravityPrintModeError } from "./antigravity-cli-log.js";

const EXIT_CLOSE_GRACE_MS = 1500;
const FORCE_KILL_GRACE_MS = 2000;

export interface LiveAntigravityProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      killProcessTree(proc);
    } else if (proc.pid) {
      // The group can outlive its leader when a managed task inherits a pipe.
      process.kill(-proc.pid, signal);
    } else if (proc.exitCode === null) {
      proc.kill(signal);
    }
  } catch {
    /* Process already exited. */
  }
}

export function terminateAntigravityProcessTree(proc: ChildProcess): void {
  signalProcessTree(proc, "SIGTERM");
  if (process.platform === "win32") return;
  const timer = setTimeout(() => signalProcessTree(proc, "SIGKILL"), FORCE_KILL_GRACE_MS);
  timer.unref?.();
}

interface TurnOpts {
  proc: ChildProcess;
  live: LiveAntigravityProcess;
  runOpts: EngineRunOpts;
  prompt: string;
  cleanup: () => void;
}

export class AntigravityHeadlessTurn {
  private settled = false;
  private startedAtMs = Date.now();
  private lineBuffer = "";
  private stderr = "";
  private conversationId: string;
  private lastContextTokens: number | undefined;
  private hardTimeout: NodeJS.Timeout | undefined;
  private exitGrace: NodeJS.Timeout | undefined;
  private resolveResult: ((result: EngineResult) => void) | undefined;
  private rejectResult: ((error: Error) => void) | undefined;

  constructor(private opts: TurnOpts) {
    this.conversationId = opts.runOpts.resumeSessionId ?? "";
  }

  run(): Promise<EngineResult> {
    return new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
      this.attach();
    });
  }

  private attach(): void {
    const { proc } = this.opts;
    proc.stdout!.on("data", this.onStdout);
    proc.stderr!.on("data", this.onStderr);
    proc.stdin!.on("error", this.onStdinError);
    proc.on("close", this.onClose);
    proc.on("exit", this.onExit);
    proc.on("error", this.onError);
    this.hardTimeout = setTimeout(this.onTimeout, ANTIGRAVITY_TURN_TIMEOUT_MS);
    this.hardTimeout.unref?.();
    proc.stdin!.end(`${JSON.stringify({ event: "user", message: { content: this.opts.prompt } })}\n`);
  }

  private onStdout = (chunk: Buffer): void => {
    if (this.settled) return;
    this.lineBuffer += chunk.toString();
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  };

  private onStderr = (chunk: Buffer): void => {
    if (!this.settled) this.stderr = (this.stderr + chunk.toString()).slice(-10 * 1024);
  };

  private onStdinError = (): void => {
    // The process close/error event provides the authoritative diagnostic.
  };

  private onClose = (code: number | null): void => {
    this.finalizeNonTerminal(code);
  };

  private onExit = (code: number | null): void => {
    if (this.settled) return;
    this.exitGrace = setTimeout(() => this.finalizeNonTerminal(code), EXIT_CLOSE_GRACE_MS);
    this.exitGrace.unref?.();
  };

  private onError = (error: Error): void => {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.rejectResult?.(new Error(`Failed to spawn Antigravity CLI: ${error.message}`));
  };

  private onTimeout = (): void => {
    if (this.settled) return;
    this.opts.live.terminationReason = "Antigravity turn timed out";
    terminateAntigravityProcessTree(this.opts.proc);
  };

  private handleLine(line: string): void {
    if (this.settled) return;
    const parsed = parseAntigravityStreamLine(line);
    if (!parsed) return;
    this.captureParsedLine(parsed);
    if (parsed.terminal) this.settleTerminal(parsed);
  }

  private captureParsedLine(parsed: AntigravityParsedLine): void {
    if (parsed.conversationId) this.conversationId = parsed.conversationId;
    if (parsed.contextTokens) this.lastContextTokens = parsed.contextTokens;
    for (const delta of parsed.deltas) this.opts.runOpts.onStream?.(delta);
  }

  private settleTerminal(parsed: AntigravityParsedLine): void {
    terminateAntigravityProcessTree(this.opts.proc);
    this.settle({
      sessionId: this.conversationId,
      result: parsed.result ?? "",
      ...(this.lastContextTokens ? { contextTokens: this.lastContextTokens } : {}),
      ...(parsed.error ? { error: parsed.error } : { numTurns: 1 }),
    });
  }

  private finalizeNonTerminal(code: number | null): void {
    if (this.settled) return;
    this.handleLine(this.lineBuffer);
    if (this.settled) return;
    const reason = this.opts.live.terminationReason;
    if (!reason) terminateAntigravityProcessTree(this.opts.proc);
    this.settle({
      sessionId: this.conversationId,
      result: "",
      error: reason ?? this.describeMissingResult(code),
      ...(this.lastContextTokens ? { contextTokens: this.lastContextTokens } : {}),
    });
  }

  /** agy's log names the real cause (usually its print-mode wall); ours names only the exit. */
  private describeMissingResult(code: number | null): string {
    const detail = this.stderr.trim().slice(0, 500);
    const exit = `Antigravity exited with code ${code}${detail ? `: ${detail}` : " without a terminal result"}`;
    const cliError = readAntigravityPrintModeError(this.startedAtMs);
    return cliError ? `${exit}. agy reported: ${cliError}` : exit;
  }

  private settle(result: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    try { this.opts.proc.unref?.(); } catch { /* already gone */ }
    this.resolveResult?.(result);
  }

  private cleanup(): void {
    if (this.hardTimeout) clearTimeout(this.hardTimeout);
    if (this.exitGrace) clearTimeout(this.exitGrace);
    const { proc } = this.opts;
    proc.stdout?.removeListener("data", this.onStdout);
    proc.stderr?.removeListener("data", this.onStderr);
    proc.stdin?.removeListener("error", this.onStdinError);
    proc.removeListener("close", this.onClose);
    proc.removeListener("exit", this.onExit);
    proc.removeListener("error", this.onError);
    this.opts.cleanup();
  }
}
