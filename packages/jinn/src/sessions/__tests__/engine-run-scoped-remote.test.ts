import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import type { Employee, EngineResult, EngineRunOpts } from "../../shared/types.js";
import { runEngineAttempt } from "../turn/engine-run.js";
import { refuseScopedTurn } from "../turn/scoped-turn.js";
import { makeSession } from "./helpers/session-fixture.js";

/**
 * A turn of a remote employee (and auto-compaction through it) runs where the employee's
 * scope puts it (FR-061): a scoped one in its department's stage directory on the host,
 * with its department and work area named; an unscoped one exactly as before.
 */

const SLUG = "engine-run-remote-dept";
const REMOTE = { root: "/srv/root", mount: "/mnt/jinn" };
const STAGE = `/srv/root/.jinn-departments/${SLUG}`;

function remoteEmployee(name: string): Employee {
  return {
    name, engine: "claude", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work",
    remoteClaudeConfigDir: "/srv/profiles/a",
  } as Employee;
}

function attempt(session: ReturnType<typeof makeSession>, employee: Employee, config: object = { remote: REMOTE }) {
  const run = vi.fn(async (_opts: EngineRunOpts) => ({ result: "ok", sessionId: "s1" }) as EngineResult);
  return runEngineAttempt({
    input: { session, attachments: [], employee, attemptToken: "t1", config } as any,
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
  writeEmployeeFile(SLUG, "remote-side-dev");
  writeEmployeeFile("engineering", "remote-eng-dev");
  refreshOrg();
});

describe("a remote turn's engine target", () => {
  it("is the department's stage directory, department and work area for a scoped employee, with host, user and profile unchanged", async () => {
    const opts = await attempt(makeSession({ employee: "remote-side-dev", scopeDepartment: SLUG }), remoteEmployee("remote-side-dev"));
    expect(opts).toMatchObject({
      remoteHost: "build-box", remoteUser: "ci", remoteCwd: STAGE, remoteClaudeConfigDir: "/srv/profiles/a",
      remoteDepartment: SLUG, remoteWorkArea: "/srv/root/work",
    });
  });

  it("is exactly host, user, cwd and profile for an unscoped employee, as before", async () => {
    const opts = await attempt(makeSession({ employee: "remote-eng-dev" }), remoteEmployee("remote-eng-dev"));
    expect(Object.keys(opts).filter((key) => key.startsWith("remote")).sort()).toEqual(["remoteClaudeConfigDir", "remoteCwd", "remoteHost", "remoteUser"]);
    expect(opts).toMatchObject({ remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work", remoteClaudeConfigDir: "/srv/profiles/a" });
  });

  it("has no remote cwd for a scoped employee when remote.root is not configured, so the engine refuses it", async () => {
    const opts = await attempt(makeSession({ employee: "remote-side-dev", scopeDepartment: SLUG }), remoteEmployee("remote-side-dev"), {});
    expect("remoteCwd" in opts).toBe(false);
  });

  it("names the local stage directory without preparing it: the host's copy is the one the session runs in", async () => {
    await attempt(makeSession({ employee: "remote-side-dev", scopeDepartment: SLUG }), remoteEmployee("remote-side-dev"));
    expect(fs.existsSync(departmentStageDir(SLUG))).toBe(false);
  });
});

describe("a remote scoped turn's preflight", () => {
  it("does not prepare the local stage directory, and a local one still does", () => {
    const session = makeSession({ employee: "remote-side-dev", scopeDepartment: SLUG, engine: "claude" });
    expect(refuseScopedTurn(session, undefined, true)).toBeUndefined();
    expect(fs.existsSync(departmentStageDir(SLUG))).toBe(false);
    expect(refuseScopedTurn(session, undefined)).toBeUndefined();
    expect(fs.existsSync(departmentStageDir(SLUG))).toBe(true);
  });
});
