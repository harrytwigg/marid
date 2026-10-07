import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The turn-level rate-limit path hands the handler the target `employeeRemoteTarget`
 * builds, not the employee's raw `remoteCwd` (FR-061): a scoped remote employee's retry
 * is placed in its department's stage directory, an unscoped one's where it always was.
 */
const handleRateLimit = vi.fn(async (_opts: Record<string, unknown>) => ({ kind: "resumed" }));
vi.mock("../rate-limit-handler.js", () => ({ handleRateLimit: (opts: Record<string, unknown>) => handleRateLimit(opts) }));

import fs from "node:fs";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import type { Employee } from "../../shared/types.js";
import { runRateLimitTurn } from "../turn/rate-limit-turn.js";
import { makeSession } from "./helpers/session-fixture.js";

const SLUG = "rl-turn-remote-dept";
const remoteEmployee = (name: string) => ({
  name, engine: "claude", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work", remoteClaudeConfigDir: "/srv/profiles/a",
}) as Employee;

function turn(session: ReturnType<typeof makeSession>, employee: Employee) {
  return runRateLimitTurn({
    input: { session, employee, attachments: [], attemptToken: "t1", prompt: "hi", config: { remote: { root: "/srv/root", mount: "/mnt/jinn" } }, engines: new Map() },
    plan: { engineConfig: {}, engine: {} },
    rateLimit: {},
    originalResult: { result: "", sessionId: "x" },
  } as any).then(() => handleRateLimit.mock.calls[0]![0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDepartmentFixtures();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\n`);
  writeEmployeeFile(SLUG, "turn-side-dev");
  writeEmployeeFile("engineering", "turn-eng-dev");
  refreshOrg();
});

describe("runRateLimitTurn", () => {
  it("passes the stage directory, department and work area for a scoped remote employee", async () => {
    const opts = await turn(makeSession({ employee: "turn-side-dev", scopeDepartment: SLUG }), remoteEmployee("turn-side-dev"));
    expect(opts).toMatchObject({
      remoteHost: "build-box", remoteCwd: `/srv/root/.jinn-departments/${SLUG}`, remoteDepartment: SLUG, remoteWorkArea: "/srv/root/work",
    });
  });

  it("passes the employee's own cwd for an unscoped remote employee", async () => {
    const opts = await turn(makeSession({ employee: "turn-eng-dev" }), remoteEmployee("turn-eng-dev"));
    expect(opts).toMatchObject({ remoteHost: "build-box", remoteCwd: "/srv/root/work" });
    expect(opts.remoteDepartment).toBeUndefined();
  });
});
