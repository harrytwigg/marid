import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({ pid: 4242, onData: () => {}, onExit: () => {}, on: () => {}, kill: () => {}, resize: () => {}, write: () => {} })),
}));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { MUSECODE_TURN_RUNNING } from "../../engines/musecode-interactive.js";
import { createMusecodeEnginePair } from "../musecode-view.js";

/** The two Muse Code engines as the gateway builds them, against the fake host (`engines/__tests__/fixtures/fake-muse.mjs`). */
const FAKE = new URL("../../engines/__tests__/fixtures/fake-muse.mjs", import.meta.url).pathname;
const ID = "01a13fb8-5801-7983-8ae6-77432f86606b";

function pair() {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
  const config = { engines: { musecode: { bin: FAKE } } } as unknown as JinnConfig;
  return createMusecodeEnginePair({ getConfig: () => config, createLifecycle: () => lifecycle, refreshPids: () => {}, engineOptions: {} });
}

describe("createMusecodeEnginePair", () => {
  let state: string;
  beforeEach(() => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-view-wiring-"));
    vi.stubEnv("FAKE_MUSE_STATE_DIR", state);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it("keeps the terminal shut while the work engine has a turn in flight, and opens it when the turn is over", async () => {
    const { work, pty } = pair();
    const run = work.run({ prompt: "x\n---\nHANG", cwd: process.cwd(), bin: FAKE, sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(work.hasLiveRun("s1")).toBe(true);
    expect(() => pty.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: process.cwd() })).toThrow(MUSECODE_TURN_RUNNING);
    expect(() => pty.restartPty("s1", { engineSessionId: ID, cwd: process.cwd() })).toThrow(MUSECODE_TURN_RUNNING);

    work.kill("s1", "Interrupted: test");
    await run;
    expect(work.hasLiveRun("s1")).toBe(false);
    expect(() => pty.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: process.cwd() })).not.toThrow();
    pty.killAll();
  }, 30_000);

  it("lets the work engine close the idle terminal ahead of a resume", async () => {
    const { work, pty } = pair();
    const first = await work.run({ prompt: "one", cwd: process.cwd(), bin: FAKE, sessionId: "s2" });
    pty.ensureIdleSpawn("s2", { engineSessionId: first.sessionId, cwd: process.cwd() });
    expect(pty.hasWarmPty("s2")).toBe(true);
    await work.run({ prompt: "two", cwd: process.cwd(), bin: FAKE, sessionId: "s2", resumeSessionId: first.sessionId });
    expect(pty.hasWarmPty("s2")).toBe(false);
  }, 30_000);
});
