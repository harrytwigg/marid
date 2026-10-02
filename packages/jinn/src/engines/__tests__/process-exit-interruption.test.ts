import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isProcessExitInterruption, processExitInterruption } from "../pty-lifecycle.js";

const ENGINES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("processExitInterruption", () => {
  it("names the engine, the exit code and the signal", () => {
    expect(processExitInterruption("codex", { exitCode: 1, signal: 0 }))
      .toBe("Interrupted: codex process exited (code 1, signal 0)");
    expect(processExitInterruption("agy", { exitCode: 0, signal: 9 }))
      .toBe("Interrupted: agy process exited (code 0, signal 9)");
  });

  it("says so rather than inventing a value when the exit is not reported", () => {
    // The claude watchdog reads node-pty's private `_exitCode` and never sees a signal.
    expect(processExitInterruption("claude", { exitCode: 137 }))
      .toBe("Interrupted: claude process exited (code 137, signal unknown)");
    expect(processExitInterruption("grok"))
      .toBe("Interrupted: grok process exited (code unknown, signal unknown)");
  });

  // sessions/turn/runner.ts:112 settles any reason starting `Interrupted` as a silent
  // preemption. Diagnostics go AFTER the sentence; a prefix would make a quiet
  // interruption a loud user-visible failure.
  it("still begins with Interrupted, whatever it carries", () => {
    expect(processExitInterruption("codex", { exitCode: 1, signal: 0 }).startsWith("Interrupted")).toBe(true);
  });
});

describe("isProcessExitInterruption", () => {
  it("recognises the enriched sentence as well as the bare one it replaced", () => {
    expect(isProcessExitInterruption("Interrupted: claude process exited")).toBe(true);
    expect(isProcessExitInterruption(processExitInterruption("claude", { exitCode: 1, signal: 0 }))).toBe(true);
  });

  it("leaves every other interrupt reason alone", () => {
    expect(isProcessExitInterruption("Interrupted: user stopped the turn")).toBe(false);
    expect(isProcessExitInterruption("Interactive turn failed: server_error")).toBe(false);
  });
});

/**
 * The five call sites, checked in the source because they live inside PTY exit
 * plumbing that no unit test can reach. What made the incident unreadable was an
 * attempt reporting an engine that was not the one that died, so what is asserted
 * is that each site names its OWN engine and that no bare literal survives.
 */
describe("every process-exit interruption names its own engine", () => {
  const SITES: readonly [file: string, engine: string, sites: number][] = [
    // One site: the turn resolver's processExited, which both the PTY's exit
    // and the watchdog go through. Its other branch is the start failure below.
    ["claude-interactive.ts", "claude", 1],
    ["codex-interactive.ts", "codex", 1],
    ["grok-interactive.ts", "grok", 1],
    ["antigravity.ts", "agy", 1],
  ];

  it.each(SITES)("%s names %s at %i site(s)", (file, engine, sites) => {
    const source = fs.readFileSync(path.join(ENGINES_DIR, file), "utf-8");
    const built = source.split(`processExitInterruption("${engine}"`).length - 1;

    expect(built).toBe(sites);
    expect(source).not.toContain(`"Interrupted: ${engine} process exited"`);
  });
});

describe("a claude process that exits before its session starts", () => {
  it("is reported as a failed start naming claude, not as an interruption", () => {
    const source = fs.readFileSync(path.join(ENGINES_DIR, "claude-interactive.ts"), "utf-8");
    expect(source.split('processStartFailure("claude"').length - 1).toBe(1);
  });
});
