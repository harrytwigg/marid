import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import type { EngineRunOpts, StreamDelta } from "../../../shared/types.js";
import { MusecodeEngine } from "../../musecode.js";

/**
 * The fake `muse serve` (fixtures/fake-muse.mjs) as a test fixture: a scratch
 * directory, the host's session store and request log pointed into it, and a
 * fresh engine per test. The files that use it must mock the logger and
 * `sessions/employee-env.js` themselves (vi.mock is hoisted per file).
 */

export const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-muse.mjs");

export interface FakeMuseContext {
  /** The engine under test: a new one for every test. */
  engine: MusecodeEngine;
  /** The scratch directory, also every run's cwd. */
  tmp: string;
  /** What the turn streamed. */
  streamed: StreamDelta[];
  logFile: string;
}

export const ctx = {} as FakeMuseContext;

/** Install the per-test setup and teardown; call once inside a `describe` or at the top of the file. */
export function useFakeMuse(): void {
  beforeEach(() => {
    ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-engine-"));
    ctx.logFile = path.join(ctx.tmp, "requests.jsonl");
    vi.stubEnv("FAKE_MUSE_STATE_DIR", path.join(ctx.tmp, "state"));
    vi.stubEnv("FAKE_MUSE_LOG", ctx.logFile);
    for (const name of ["FAKE_MUSE_RESET_MS", "FAKE_MUSE_RESUME_FAIL", "FAKE_MUSE_IN_USE", "FAKE_MUSE_BOOT_EXIT", "FAKE_MUSE_NO_GRANT"]) vi.stubEnv(name, "");
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CODEX_HOME", "/somewhere");
    ctx.streamed = [];
    ctx.engine = new MusecodeEngine();
  });

  afterEach(() => {
    ctx.engine.killAll();
    vi.unstubAllEnvs();
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  });
}

export function opts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "hello", cwd: ctx.tmp, bin: FAKE, sessionId: "s1", onStream: (d) => ctx.streamed.push(d), ...over };
}

/** What the fake host was sent: one entry per request, and the process start. */
export function requests(): Array<Record<string, any>> {
  return fs.existsSync(ctx.logFile) ? fs.readFileSync(ctx.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
export const methods = (): string[] => requests().filter((r) => r.method).map((r) => r.method as string);
export const sent = (method: string): Array<Record<string, any>> => requests().filter((r) => r.method === method).map((r) => r.params as Record<string, any>);
export const starts = (): Array<Record<string, any>> => requests().filter((r) => r.start);
