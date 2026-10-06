import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A department-scoped LOCAL session skips the instructions in every directory above its
 * stage directory, as a remote one does: the stage directory sits beside the instance
 * home, so the operator's home directory is one of them. Its settings carry
 * `claudeMdExcludes`, and its turn is refused when the installed Claude Code cannot be
 * told to skip them.
 */

const hoisted = vi.hoisted(() => ({ session: undefined as unknown }));
vi.mock("../registry.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSession: () => hoisted.session,
}));

const { claudeKnowsMdExcludes, clearClaudeMdExcludesCacheForTests, setClaudeMdExcludesProbe } = await import("../../shared/claude-md-excludes.js");
const { writeClaudeSessionSettings } = await import("../../engines/claude-profile-launch.js");
const { departmentStageDir } = await import("../../gateway/department-scope/paths.js");
const { refreshOrg } = await import("../../gateway/org-registry.js");
const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { refuseScopedTurn } = await import("../turn/scoped-turn.js");
const { makeSession } = await import("./helpers/session-fixture.js");

const SLUG = "local-excludes-dept";
let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-bin-")));
  clearClaudeMdExcludesCacheForTests();
  resetDepartmentFixtures();
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\n`);
  writeEmployeeFile(SLUG, "local-side-dev");
  writeEmployeeFile("engineering", "local-eng-dev");
  refreshOrg();
});

afterEach(() => {
  setClaudeMdExcludesProbe(null);
  hoisted.session = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bin = (name: string, content: string | Buffer) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
};

describe("claudeKnowsMdExcludes", () => {
  it("finds the setting's name in a binary, through a link, and not in one that lacks it or does not exist", () => {
    const knows = bin("new", "#!/bin/sh\n# claudeMdExcludes\n");
    fs.symlinkSync(knows, path.join(tmp, "claude"));
    expect(claudeKnowsMdExcludes(knows)).toBe(true);
    expect(claudeKnowsMdExcludes(path.join(tmp, "claude"))).toBe(true);
    expect(claudeKnowsMdExcludes(bin("old", "#!/bin/sh\n"))).toBe(false);
    expect(claudeKnowsMdExcludes(path.join(tmp, "missing"))).toBe(false);
  });

  it("finds a name that straddles two read chunks", () => {
    const chunk = 4 * 1024 * 1024;
    const content = Buffer.alloc(chunk + 64, 0x20);
    content.write("claudeMdExcludes", chunk - 5);
    expect(claudeKnowsMdExcludes(bin("big", content))).toBe(true);
  });

  it("answers again when the binary is replaced", () => {
    const file = bin("swap", "#!/bin/sh\n");
    expect(claudeKnowsMdExcludes(file)).toBe(false);
    fs.writeFileSync(file, "#!/bin/sh\n# claudeMdExcludes, now\n");
    expect(claudeKnowsMdExcludes(file)).toBe(true);
  });
});

describe("a scoped local session's settings", () => {
  const settingsOf = (session: { id: string }) => {
    hoisted.session = session;
    return JSON.parse(fs.readFileSync(writeClaudeSessionSettings(String(session.id), undefined), "utf-8"));
  };

  it("exclude the instruction files in every directory above the stage directory, and none inside it", () => {
    const stage = departmentStageDir(SLUG);
    const settings = settingsOf(makeSession({ id: "scoped-local-1", employee: "local-side-dev", scopeDepartment: SLUG }));
    const above = path.dirname(stage);
    expect(settings.claudeMdExcludes).toEqual(expect.arrayContaining([
      `${above}/CLAUDE.md`, `${above}/CLAUDE.local.md`, `${path.dirname(above)}/CLAUDE.md`, "/CLAUDE.md",
    ]));
    expect(settings.claudeMdExcludes.some((pattern: string) => pattern.startsWith(`${stage}/`))).toBe(false);
  });

  it("carry no exclusions for an unscoped session", () => {
    expect(settingsOf(makeSession({ id: "unscoped-local-1", employee: "local-eng-dev" })).claudeMdExcludes).toBeUndefined();
  });
});

describe("a scoped local turn", () => {
  const session = () => makeSession({ employee: "local-side-dev", scopeDepartment: SLUG, engine: "claude" });

  it("is refused when the installed Claude Code cannot skip the instructions above its stage directory", () => {
    setClaudeMdExcludesProbe(claudeKnowsMdExcludes);
    expect(refuseScopedTurn(session(), undefined, false, bin("old-claude", "#!/bin/sh\n"))).toMatch(/cannot be told to skip the CLAUDE\.md files above the department's stage directory/);
    expect(refuseScopedTurn(session(), undefined, false, bin("new-claude", "# claudeMdExcludes\n"))).toBeUndefined();
  });

  it("does not ask on a remote host, where the sync checks the host's own Claude Code", () => {
    const probe = vi.fn(() => false);
    setClaudeMdExcludesProbe(probe);
    expect(refuseScopedTurn(session(), undefined, true)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
