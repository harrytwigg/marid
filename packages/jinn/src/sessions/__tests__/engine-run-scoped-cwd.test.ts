import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resolvedStageDir } from "../../gateway/department-stage/stage.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineResult, EngineRunOpts } from "../../shared/types.js";
import { refuseScopedTurn } from "../turn/scoped-turn.js";
import { runEngineAttempt } from "../turn/engine-run.js";
import { makeSession } from "./helpers/session-fixture.js";

/**
 * Turns, and auto-compaction through them, run a scoped session in its stage directory
 * (FR-020, FR-020b); a turn whose stage directory cannot be prepared is refused up front.
 */

const SLUG = "engine-run-dept";

function attempt(session: ReturnType<typeof makeSession>, employee: { name: string } | undefined) {
  const run = vi.fn(async (_opts: EngineRunOpts) => ({ result: "ok", sessionId: "s1" }) as EngineResult);
  return runEngineAttempt({
    input: { session, attachments: [], employee, attemptToken: "t1" } as any,
    plan: {
      engine: { run }, engineConfig: {}, promptToRun: "hi", runtimeSource: "web",
      prepareContext: () => ({ systemPrompt: "sys", fingerprint: "f", refresh: undefined }),
    } as any,
    surface: {} as any,
    heartbeat: { beat() {} } as any,
    partialStream: { finish() {}, persist() {} } as any,
    turnStartedAt: Date.now(),
    model: undefined,
  }).then(() => run.mock.calls[0]![0]);
}

beforeEach(() => {
  resetDepartmentFixtures();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\n`);
  writeEmployeeFile(SLUG, "engine-run-dev");
  writeEmployeeFile("engineering", "engine-run-eng");
  refreshOrg();
});

describe("a turn's engine cwd", () => {
  it("is the stage directory for a scoped session", async () => {
    const opts = await attempt(makeSession({ employee: "engine-run-dev", scopeDepartment: SLUG }), { name: "engine-run-dev" });
    expect(opts.cwd).toBe(resolvedStageDir(SLUG));
    expect(fs.readFileSync(path.join(opts.cwd!, "CLAUDE.md"), "utf-8")).toContain("scoped to the **engine-run-dept** department");
  });

  it("is the Jinn home for an unscoped session", async () => {
    const opts = await attempt(makeSession({ employee: "engine-run-eng" }), { name: "engine-run-eng" });
    expect(opts.cwd).toBe(JINN_HOME);
  });

  it("is refused before the engine is asked when the stage directory cannot be prepared", () => {
    const root = path.dirname(departmentStageDir(SLUG));
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "not a directory");
    try {
      expect(refuseScopedTurn(makeSession({ employee: "engine-run-dev", scopeDepartment: SLUG }), undefined))
        .toMatch(/cannot start a turn: the stage directory for department "engine-run-dept" could not be prepared/);
    } finally {
      fs.rmSync(root, { force: true });
    }
  });

  it("is not refused when the stage directory is in place", () => {
    expect(refuseScopedTurn(makeSession({ employee: "engine-run-dev", scopeDepartment: SLUG }), undefined)).toBeUndefined();
  });
});
