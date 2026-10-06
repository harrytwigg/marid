import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resetDepartmentFixtures, writeDepartmentFile, writeSkill } from "./department-fixtures.js";

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
  const refusals: Array<[string, string, RegExp]> = [
    ["YAML that does not parse", "name: side-project\nscope: [unclosed\n", /does not parse/],
    ["a file that is not a mapping", "- just\n- a list\n", /mapping/],
    ["a name that is not the directory's", "name: another-project\nscope: scoped\n", /does not match the directory/],
    ["an unknown scope", "name: side-project\nscope: sealed\n", /unknown scope/],
    ["a non-text scope", "name: side-project\nscope: true\n", /unknown scope/],
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

  it.each(refusals)("%s: a department that never loaded counts as dedicated", (_label, text, why) => {
    writeDepartmentFile("side-project", text);
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("dedicated");
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
    writeDepartmentFile("side-project", "name: side-project\nscope: sealed\n");
    refreshDepartments();
    refreshDepartments();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/treated as dedicated until the file loads/);
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
