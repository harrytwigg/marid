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

const { claudeMdExcludesProblem, clearClaudeMdExcludesCacheForTests, localClaudeMdExcludesProblem, setClaudeMdExcludesProbe } = await import("../../shared/claude-md-excludes.js");
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

/** A stand-in Claude Code that prints `version` for `--version`, as a wrapper script would. */
const claude = (name: string, version: string) => bin(name, `#!/bin/sh\n[ "$1" = --version ] && echo "${version} (Claude Code)"\n`);

describe("claudeMdExcludesProblem", () => {
  it("passes the minimum and later, and names the version and the minimum otherwise", () => {
    for (const ok of ["2.1.288 (Claude Code)", "2.1.291", "2.2.0", "3.0.0"]) expect(claudeMdExcludesProblem("x", ok), ok).toBeNull();
    expect(claudeMdExcludesProblem("/opt/claude", "2.1.287 (Claude Code)")).toMatch(/^the Claude Code at \/opt\/claude reports 2\.1\.287; a department-scoped session needs 2\.1\.288 or later/);
    expect(claudeMdExcludesProblem("/opt/claude", "1.9.999")).toMatch(/reports 1\.9\.999/);
    expect(claudeMdExcludesProblem("/opt/claude", "")).toMatch(/did not report a version/);
  });
});

describe("localClaudeMdExcludesProblem", () => {
  it("asks the binary, through a link or a wrapper script, and refuses one that is old, silent or missing", () => {
    const current = claude("current", "2.1.291");
    fs.symlinkSync(current, path.join(tmp, "claude"));
    expect(localClaudeMdExcludesProblem(current)).toBeNull();
    expect(localClaudeMdExcludesProblem(path.join(tmp, "claude"))).toBeNull();
    expect(localClaudeMdExcludesProblem(claude("old", "2.0.14"))).toMatch(/reports 2\.0\.14/);
    expect(localClaudeMdExcludesProblem(bin("silent", "#!/bin/sh\nexit 1\n"))).toMatch(/did not report a version/);
    expect(localClaudeMdExcludesProblem(path.join(tmp, "missing"))).toMatch(/did not report a version/);
  });

  it("asks again when the binary is replaced", () => {
    const file = claude("swap", "2.0.1");
    expect(localClaudeMdExcludesProblem(file)).not.toBeNull();
    fs.writeFileSync(file, '#!/bin/sh\necho "2.1.300 (Claude Code), upgraded"\n');
    expect(localClaudeMdExcludesProblem(file)).toBeNull();
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
    setClaudeMdExcludesProbe(localClaudeMdExcludesProblem);
    expect(refuseScopedTurn(session(), undefined, false, claude("old-claude", "2.0.14"))).toMatch(/^This department-scoped session cannot start a turn: the Claude Code at .*old-claude reports 2\.0\.14; .*claudeMdExcludes/);
    expect(refuseScopedTurn(session(), undefined, false, claude("new-claude", "2.1.291"))).toBeUndefined();
  });

  it("does not ask on a remote host, where the sync checks the host's own Claude Code", () => {
    const probe = vi.fn((): string | null => "too old");
    setClaudeMdExcludesProbe(probe);
    expect(refuseScopedTurn(session(), undefined, true)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
