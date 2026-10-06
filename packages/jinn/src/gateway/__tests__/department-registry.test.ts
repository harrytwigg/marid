import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initDb } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { departmentScope } from "../../work-items/department-scope.js";
import {
  departmentRecord,
  departmentScopeOf,
  refreshDepartments,
  setDepartmentChangeListener,
} from "../department-registry.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "./department-fixtures.js";

/** FR-001: what a department's file says, what a broken or missing one does, and the last good scope. */

const recorded = (slug: string) =>
  initDb().prepare("SELECT scope FROM department_scopes WHERE slug = ?").pluck().get(slug) as string | undefined;

beforeEach(() => resetDepartmentFixtures());
afterEach(() => vi.restoreAllMocks());

describe("with no department.yaml anywhere", () => {
  it("holds every department open and logs nothing", () => {
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    fs.mkdirSync(path.join(resolveJinnHome(), "org", "engineering"), { recursive: true });
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("open");
    expect(departmentScopeOf("anything-else")).toBe("open");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("hands the work-items layer a resolver once the registry has loaded", () => {
    expect(departmentScope("side-project")).toBe("open");
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshDepartments();
    expect(departmentScope("side-project")).toBe("scoped");
    expect(departmentScope(null)).toBe("open");
  });
});

describe("a department file that loads", () => {
  it.each(["open", "scoped", "dedicated"] as const)("carries scope: %s and records it", (scope) => {
    writeDepartmentFile("side-project", `name: side-project\nscope: ${scope}\n`);
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe(scope);
    expect(recorded("side-project")).toBe(scope);
  });

  it("is open when scope is absent", () => {
    writeDepartmentFile("side-project", "name: side-project\ndisplayName: Side project\n");
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
    expect(departmentRecord("side-project").definition?.displayName).toBe("Side project");
  });

  it("reads the whole definition for a scoped department", () => {
    writeSkill("review");
    const code = fs.mkdtempSync(path.join(resolveJinnHome(), "..", "code-"));
    try {
      writeDepartmentFile(
        "side-project",
        [
          "name: side-project",
          "displayName: Side project",
          "description: Friend's side project",
          "scope: scoped",
          `skills: [review]`,
          "sharedNotes: [knowledge/shared/glossary.md, docs]",
          "instructions: department+company",
          "workdirs: []",
        ].join("\n"),
      );
      refreshDepartments();
      const { definition } = departmentRecord("side-project");
      expect(definition).toMatchObject({
        displayName: "Side project",
        description: "Friend's side project",
        skills: ["review"],
        sharedNotes: ["knowledge/shared/glossary.md", "docs"],
        instructions: "department+company",
      });
    } finally {
      fs.rmSync(code, { recursive: true, force: true });
    }
  });

  it("does not read the extras of an open department", () => {
    writeSkill("review");
    writeDepartmentFile("side-project", "name: side-project\nscope: open\nskills: [review]\ninstructions: department+company\n");
    refreshDepartments();
    expect(departmentRecord("side-project").definition).toMatchObject({ skills: [], instructions: "department" });
  });

  it("opens a department only when the file says scope: open", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshDepartments();
    writeDepartmentFile("side-project", "name: side-project\nscope: open\n");
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
    expect(recorded("side-project")).toBe("open");
  });
});

describe("identity problems refuse the file", () => {
  /** [label, file text, why it is refused, whether the text has a scope other than open] */
  const refusals: Array<[string, string, RegExp, boolean]> = [
    ["YAML that does not parse", "scope: scoped\nname: [unclosed\n", /does not parse/, true],
    ["YAML that does not parse and has no scope", "name: side-project\ndescription: Builds: and ships\n", /does not parse/, false],
    ["a file that is not a mapping", "- just\n- a list\n", /mapping/, false],
    ["a name that is not the directory's", "name: another-project\nscope: scoped\n", /does not match the directory/, true],
    ["a name that is not the directory's and scope: scoped", "name: other\nscope: scoped\n", /does not match the directory/, true],
    ["a name that is not the directory's and no scope", "name: Another\n", /does not match the directory/, false],
    ["a name that is not the directory's and scope: open", "name: Another\nscope: open  # as before\n", /does not match the directory/, false],
    ["YAML that does not parse and scope: open, quoted", "scope: \"open\"\nname: [unclosed\n", /does not parse/, false],
    ["a flow mapping with a wrong name and a scope", "{name: other, scope: scoped}\n", /does not match the directory/, true],
    ["a wrong name and a quoted, capitalised scope", "name: other\nscope: \"Scoped\"\n", /does not match the directory/, true],
    ["YAML that does not parse and a commented-out scope", "# scope: scoped\nname: [unclosed\n", /does not parse/, false],
    ["a mistyped scope", "name: side-project\nscope: scopd\n", /unknown scope/, true],
    ["an unknown scope", "name: side-project\nscope: sealed\n", /unknown scope/, true],
    ["a non-text scope", "name: side-project\nscope: true\n", /unknown scope/, true],
    ["a scope key with no value", "name: side-project\nscope:\ndescription: x: y\n", /does not parse/, false],
    ["a dedicated scope behind a bad name, in quotes", "name: x\nscope : 'Dedicated'\n", /does not match the directory/, true],
    ["a key spelled SCOPE, which is no scope key", "name: x\nSCOPE: dedicated\n", /does not match the directory/, false],
    ["scope: written inside a description of a parsed file", "name: x\ndescription: |\n  scope: dedicated\n", /does not match the directory/, false],
    ["YAML that does not parse and scope: OPEN, which is not open", "name: [unclosed\nscope: OPEN\n", /does not parse/, true],
    ["a parsed file with scope: OPEN, which is not open", "name: x\nscope: OPEN\n", /does not match the directory/, true],
    ["YAML that does not parse and an empty scope key before another key", "name: [unclosed\nscope:\ndescription: x\n", /does not parse/, false],
    ["YAML that does not parse and a key spelled Scope", "name: [unclosed\nScope: scoped\n", /does not parse/, false],
    ["YAML that does not parse and a mistyped scope", "name: [unclosed\nscope: scopd\n", /does not parse/, true],
    ["YAML that does not parse and scope: dedicated", "name: [unclosed\nscope: dedicated\n", /does not parse/, true],
    ["a scope written as a list holding open", "name: side-project\nscope: [open]\n", /unknown scope/, true],
    ["a quoted scope that is open only once trimmed", "name: side-project\nscope: \" open\"\n", /unknown scope/, true],
    ["a document that parses to text with a scope line in it", "|\n  scope: dedicated\n", /mapping/, false],
  ];

  it.each(refusals)("%s: a department that was scoped keeps that scope", (_label, text, why) => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshDepartments();
    writeDepartmentFile("side-project", text);
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("scoped");
    expect(departmentRecord("side-project").definitionError).toMatch(why);
    expect(recorded("side-project")).toBe("scoped");
  });

  it.each(refusals)("%s: a department that never loaded is dedicated only if the text names a scope other than open", (_label, text, why, asks) => {
    writeDepartmentFile("side-project", text);
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe(asks ? "dedicated" : "open");
    expect(departmentRecord("side-project").definitionError).toMatch(why);
    expect(recorded("side-project")).toBeUndefined();
  });

  it.each(["system", "org"])("refuses a non-open scope on %s", (slug) => {
    writeDepartmentFile(slug, `name: ${slug}\nscope: scoped\n`);
    refreshDepartments();
    expect(departmentRecord(slug).definitionError).toMatch(/cannot be scoped/);
    expect(departmentScopeOf(slug)).toBe("open");
  });

  it("lets system and org say scope: open", () => {
    writeDepartmentFile("system", "name: system\nscope: open\n");
    refreshDepartments();
    expect(departmentRecord("system").definitionError).toBeNull();
  });

  it("tolerates a file with no name, which the shipped docs never required", () => {
    writeDepartmentFile("side-project", "scope: scoped\n");
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("scoped");
    expect(departmentRecord("side-project").definitionError).toBeNull();
  });

  it("treats an empty file as an open definition", () => {
    writeDepartmentFile("side-project", "");
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
    expect(departmentRecord("side-project").definitionError).toBeNull();
  });

  it("logs a refusal once, saying what the department falls back to", () => {
    const error = vi.spyOn(logger, "error");
    writeDepartmentFile("side-project", "name: wrong\nscope: scoped\n");
    writeDepartmentFile("quiet", "name: quiet\ndescription: Builds: and ships\n");
    refreshDepartments();
    refreshDepartments();
    expect(error).toHaveBeenCalledTimes(2);
    const messages = error.mock.calls.map((call) => call[0] as string);
    expect(messages.find((m) => m.includes("side-project"))).toMatch(/names a scope, so it is treated as dedicated until the file loads/);
    expect(messages.find((m) => m.includes("quiet"))).toMatch(/has no scope other than open, so the department stays open/);
  });
});

describe("a deleted file", () => {
  it("keeps the last good scope", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    refreshDepartments();
    fs.rmSync(path.join(resolveJinnHome(), "org", "side-project", "department.yaml"));
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("dedicated");
    expect(departmentRecord("side-project").definitionFile).toBeNull();
  });

  it("is open when nothing was ever recorded", () => {
    fs.mkdirSync(path.join(resolveJinnHome(), "org", "side-project"), { recursive: true });
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
  });

  it("keeps a recorded scope when the registry is rebuilt from the table, not the process", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshDepartments();
    fs.rmSync(path.join(resolveJinnHome(), "org", "side-project", "department.yaml"));
    resetDepartmentFixturesKeepingRows();
    expect(departmentScopeOf("side-project")).toBe("scoped");
  });
});

function resetDepartmentFixturesKeepingRows(): void {
  // A process restart: memory is gone, the table stays.
  const rows = initDb().prepare("SELECT slug, scope, recorded_at FROM department_scopes").all() as Array<Record<string, string>>;
  resetDepartmentFixtures();
  for (const row of rows) initDb().prepare("INSERT OR REPLACE INTO department_scopes (slug, scope, recorded_at) VALUES (?, ?, ?)").run(row.slug, row.scope, row.recorded_at);
}

describe("content problems drop only the entry", () => {
  it("drops a missing skill and keeps the scope and the rest", () => {
    writeSkill("review");
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\nskills: [review, no-such-skill]\n");
    const warn = vi.spyOn(logger, "warn");
    refreshDepartments();
    const record = departmentRecord("side-project");
    expect(record.scope).toBe("scoped");
    expect(record.definitionError).toBeNull();
    expect(record.definition?.skills).toEqual(["review"]);
    expect(record.warnings.join(" ")).toMatch(/no-such-skill/);
    expect(warn).toHaveBeenCalled();
  });

  it("refuses a skill name that tries to leave the skills directory", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\nskills: ['../config']\n");
    refreshDepartments();
    expect(departmentRecord("side-project").definition?.skills).toEqual([]);
  });

  it("drops a working directory that fails FR-033", () => {
    writeDepartmentFile("side-project", `name: side-project\nscope: scoped\nworkdirs: ['${resolveJinnHome()}', '/definitely/not/here']\n`);
    refreshDepartments();
    const record = departmentRecord("side-project");
    expect(record.scope).toBe("scoped");
    expect(record.definition?.workdirs).toEqual([]);
    expect(record.warnings).toHaveLength(2);
  });

  describe("an employee's Claude profile (FR-033)", () => {
    // Beside the instance home: the test temp directory sits inside it, which is a protected tree.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(resolveJinnHome()), "jinn-department-profile-")));
    const profile = path.join(repo, "profile");
    beforeAll(() => {
      fs.mkdirSync(path.join(profile, "projects"), { recursive: true });
      fs.mkdirSync(path.join(repo, "app"), { recursive: true });
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    });
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
    const workdirs = `workdirs: ['${repo}', '${profile}', '${path.join(profile, "projects")}', '${path.join(repo, "app")}']`;

    it("is kept when no employee runs on it", () => {
      writeDepartmentFile("side-project", `name: side-project\nscope: scoped\n${workdirs}\n`);
      refreshDepartments();
      expect(departmentRecord("side-project").definition?.workdirs).toEqual([repo, profile, path.join(profile, "projects"), path.join(repo, "app")]);
    });

    it.each([
      ["an employee that loads", "engineering", {}],
      ["an employee the scan refuses", "side-project", { department: "engineering" }],
    ])("is dropped, with what contains it, when %s runs on it", (_label, directory, extra) => {
      writeDepartmentFile("side-project", `name: side-project\nscope: scoped\n${workdirs}\n`);
      writeEmployeeFile(directory, "friend", { ...extra, claudeConfigDir: profile });
      refreshOrg();
      expect(orgRegistry().has("friend")).toBe(directory === "engineering");
      const record = departmentRecord("side-project");
      expect(record.definition?.workdirs).toEqual([path.join(repo, "app")]);
      expect(record.warnings.filter((warning) => warning.startsWith("workdirs:"))).toHaveLength(3);
    });
  });

  it.each(["../secrets", "/etc/passwd", "config.yaml", "org/engineering", "knowledge/../config.yaml", "docs\\..\\x"])(
    "drops the shared-notes path %s",
    (entry) => {
      writeDepartmentFile("side-project", `name: side-project\nscope: scoped\nsharedNotes: ['${entry}', knowledge/ok.md]\n`);
      refreshDepartments();
      expect(departmentRecord("side-project").definition?.sharedNotes).toEqual(["knowledge/ok.md"]);
    },
  );

  it("ignores an unknown instructions mode", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\ninstructions: everything\n");
    refreshDepartments();
    expect(departmentRecord("side-project").definition?.instructions).toBe("department");
  });
});

describe("a near-miss file name", () => {
  it("warns that department.yml is not read", () => {
    const warn = vi.spyOn(logger, "warn");
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n", "department.yml");
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toMatch(/department\.yml is not read/);
  });
});

describe("change notification", () => {
  it("stays quiet on the first load and on a refresh that changes nothing, and speaks when a department changes", () => {
    const seen: string[] = [];
    setDepartmentChangeListener((slug) => seen.push(slug));
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshDepartments();
    expect(seen).toEqual([]);
    refreshDepartments();
    expect(seen).toEqual([]);
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    refreshDepartments();
    expect(seen).toEqual(["side-project"]);
    writeDepartmentFile("side-project", "name: side-project\nscope: sealed\n");
    refreshDepartments();
    expect(seen).toEqual(["side-project", "side-project"]);
  });
});
