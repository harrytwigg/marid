import fs from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { call, sessionOf, startScopedHarness } from "./department-scope-harness.js";

/**
 * Duplicating a session forks its engine thread by resuming it, and Claude Code looks the
 * thread up by cwd. A scoped session ran in its department's stage directory, so the
 * fork runs there too (FR-020b); anyone else's runs in the Jinn home.
 */

const forks = vi.hoisted(() => [] as Array<{ engineSessionId: string; cwd: string; scopedSession?: boolean }>);
vi.mock("../../sessions/fork.js", () => ({
  forkEngineSession: vi.fn(async (_engine: string, engineSessionId: string, cwd: string, opts: { scopedSession?: boolean }) => {
    forks.push({ engineSessionId, cwd, scopedSession: opts.scopedSession });
    return { engineSessionId: "forked-thread" };
  }),
}));

let registry: Awaited<ReturnType<typeof startScopedHarness>>["registry"];

beforeAll(async () => {
  ({ registry } = await startScopedHarness());
});

async function duplicate(employee: string | null, thread: string) {
  const session = await sessionOf(employee);
  registry.recordEngineSessionId(session.id, "claude", thread);
  return call("POST", `/api/sessions/${session.id}/duplicate`);
}

describe("POST /api/sessions/:id/duplicate", () => {
  it("forks a scoped session in its stage directory, on the scoped environment", async () => {
    const { departmentStageDir } = await import("../department-scope/paths.js");
    const response = await duplicate("side-dev", "scoped-thread");
    expect(response.status).toBe(200);
    expect(forks.at(-1)).toEqual({ engineSessionId: "scoped-thread", cwd: fs.realpathSync(departmentStageDir("side-project")), scopedSession: true });
    fs.rmSync(departmentStageDir("side-project"), { recursive: true, force: true });
  });

  it("forks an unscoped session in the Jinn home, on the gateway's environment", async () => {
    const { JINN_HOME } = await import("../../shared/paths.js");
    const response = await duplicate("eng-dev", "open-thread");
    expect(response.status).toBe(200);
    expect(forks.at(-1)).toEqual({ engineSessionId: "open-thread", cwd: JINN_HOME, scopedSession: false });
  });
});
