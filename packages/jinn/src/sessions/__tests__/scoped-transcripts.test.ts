import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeProjectSlug, findSessionTranscript, findTranscriptForSession } from "../../engines/claude-transcript-path.js";
import { findTranscriptOfSession } from "../../gateway/session-claude-profile.js";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import { claudeProjectDir } from "../fork.js";
import { claudeProjectsDirFor } from "../../shared/claude-profile.js";
import { JINN_HOME } from "../../shared/paths.js";
import { spawnCwd } from "../session-cwd.js";

/**
 * FR-020a, T061: resume, fork and auto-compaction find a scoped session's transcript
 * under the stage directory's slug. Claude Code files a transcript under the project
 * key of the cwd it ran in; the stage directory is that cwd for a scoped session.
 */

const SLUG = "transcript-dept";
const ID = "11111111-2222-3333-4444-555555555555";
const projects = () => claudeProjectsDirFor(null);

function transcript(cwd: string, id = ID): string {
  const file = path.join(projects(), claudeProjectSlug(cwd), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user"}\n');
  return file;
}

beforeEach(() => {
  resetDepartmentFixtures();
  fs.rmSync(projects(), { recursive: true, force: true });
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\n`);
  writeEmployeeFile(SLUG, "transcript-dev");
  writeEmployeeFile("engineering", "transcript-eng");
  refreshOrg();
});

describe("the project slug", () => {
  it("replaces every non-alphanumeric character, as Claude Code does", () => {
    expect(claudeProjectSlug("/Users/h/.jinn")).toBe("-Users-h--jinn");
    expect(claudeProjectSlug("/Users/h/.jinn-departments/side_project")).toBe("-Users-h--jinn-departments-side-project");
  });

  it("is the one the fork polls and the readers look under", () => {
    const stage = departmentStageDir(SLUG);
    expect(claudeProjectDir(stage)).toBe(path.join(projects(), claudeProjectSlug(stage)));
  });
});

describe("finding a transcript", () => {
  it("looks under the cwd's slug first: a scoped session's transcript is the stage directory's, not another project's", () => {
    const stage = departmentStageDir(SLUG);
    const decoy = transcript("/aaa-decoy-project");
    const real = transcript(stage);
    expect(real).not.toBe(decoy);
    expect(findTranscriptForSession(ID, stage, projects())).toBe(real);
    expect(findSessionTranscript(ID, undefined, stage)).toBe(real);
  });

  it("finds a scoped session's transcript through the session (resume, external turns, compaction stats)", () => {
    const real = transcript(departmentStageDir(SLUG));
    transcript(JINN_HOME, "other-id");
    expect(findTranscriptOfSession({ employee: "transcript-dev", scopeDepartment: SLUG }, ID)).toBe(real);
    expect(findTranscriptOfSession({ employee: "transcript-dev" }, ID)).toBe(real);
  });

  it("an unscoped session's transcript is still the Jinn home's", () => {
    const decoy = transcript("/aaa-decoy-project");
    const real = transcript(JINN_HOME);
    expect(real).not.toBe(decoy);
    expect(findTranscriptOfSession({ employee: "transcript-eng" }, ID)).toBe(real);
    expect(findTranscriptOfSession({ employee: null }, ID)).toBe(real);
  });

  it("the cwd a fork runs in, and the project directory it polls, are the stage directory's for a scoped source", () => {
    const cwd = spawnCwd({ employee: "transcript-dev", scopeDepartment: SLUG });
    expect(cwd).toBe(fs.realpathSync(departmentStageDir(SLUG)));
    expect(claudeProjectDir(cwd)).toBe(path.join(projects(), claudeProjectSlug(cwd)));
    expect(spawnCwd({ employee: "transcript-eng" })).toBe(JINN_HOME);
  });
});
