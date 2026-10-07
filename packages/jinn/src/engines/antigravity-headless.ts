import { spawn, type ChildProcess } from "node:child_process";
import type { EngineRunOpts, EngineResult, InterruptibleEngine } from "../shared/types.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { spawnableCommand } from "../shared/windows-spawn.js";
import {
  antigravityJinnSessionEnv,
  cleanupAntigravityJinnMcpConfig,
  ensureAntigravityJinnMcpConfig,
} from "./antigravity-mcp.js";
import {
  AntigravityHeadlessTurn,
  terminateAntigravityProcessTree,
  type LiveAntigravityProcess,
} from "./antigravity-headless-turn.js";

export {
  ANTIGRAVITY_TURN_TIMEOUT_MS,
  buildAntigravityHeadlessArgs,
  parseAntigravityStreamLine,
  type AntigravityParsedLine,
} from "./antigravity-headless-protocol.js";
import { buildAntigravityHeadlessArgs } from "./antigravity-headless-protocol.js";
import { employeeSessionEnv } from "../sessions/employee-env.js";

function buildPrompt(opts: EngineRunOpts): string {
  let prompt = opts.prompt;
  if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
  if (opts.attachments?.length) {
    prompt += "\n\nAttached files:\n" + opts.attachments.map((attachment) => `- ${attachment}`).join("\n");
  }
  return prompt;
}

function spawnHeadless(opts: EngineRunOpts): ChildProcess {
  const launch = spawnableCommand(
    resolveBin("agy", opts.bin),
    buildAntigravityHeadlessArgs(opts),
  );
  return spawn(launch.command, launch.args, {
    cwd: opts.cwd,
    env: {
      ...buildEngineChildEnv(process.env),
      ...employeeSessionEnv(opts.sessionId),
      ...antigravityJinnSessionEnv(opts.resolvedMcp),
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...launch.options,
  });
}

export class AntigravityHeadlessEngine implements InterruptibleEngine {
  name = "antigravity" as const;
  private liveProcesses = new Map<string, LiveAntigravityProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`;
    terminateAntigravityProcessTree(live.proc);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  killIdle(): void {
    /* Batch engine processes exist only while a turn is active. */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId ?? `antigravity-${Date.now()}`;
    const prompt = buildPrompt(opts);
    const mcpConfig = ensureAntigravityJinnMcpConfig(opts.resolvedMcp);
    let proc: ChildProcess;
    try {
      proc = spawnHeadless(opts);
    } catch (error) {
      cleanupAntigravityJinnMcpConfig(mcpConfig);
      throw error;
    }
    const live: LiveAntigravityProcess = { proc, terminationReason: null };
    this.liveProcesses.set(trackingId, live);
    return new AntigravityHeadlessTurn({
      proc,
      live,
      runOpts: opts,
      prompt,
      cleanup: () => {
        cleanupAntigravityJinnMcpConfig(mcpConfig);
        this.liveProcesses.delete(trackingId);
      },
    }).run();
  }
}
