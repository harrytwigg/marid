import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The scan rules of the project registry (FR-001): what refuses a file, what drops an entry, what is kept. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-project-registry-"));
process.env.JINN_HOME = tmp;

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

type Registry = typeof import("../project-registry.js");
let registry: Registry;
let db: import("better-sqlite3").Database;
let logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const dir = path.join(tmp, "projects");
const ID_A = "prj_aaaaaaaaaaaa";
const ID_B = "prj_bbbbbbbbbbbb";

function write(file: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}
const doc = (id: string, name: string, extra = ""): string => `id: ${id}\nname: ${name}\n${extra}`;

beforeAll(async () => {
  registry = await import("../project-registry.js");
  db = (await import("../../shared/db.js")).initDb();
  logger = (await import("../../shared/logger.js")).logger as unknown as typeof logger;
  fs.mkdirSync(path.join(tmp, "skills", "review"), { recursive: true });
});

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  registry.resetProjectRegistryForTests();
  db.prepare("DELETE FROM project_ids_seen").run();
  vi.clearAllMocks();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const names = () => registry.refreshProjects().projects.map((p) => p.name);

describe("a missing projects/ directory", () => {
  it("is an empty set, and logs nothing", () => {
    expect(registry.refreshProjects().projects).toEqual([]);
    expect(registry.readProjects().byId.size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("identity problems refuse the file", () => {
  it.each([
    ["a missing id", "name: Garden Planner\n"],
    ["a malformed id", doc("prj_xyz", "Garden Planner")],
    ["a missing name", `id: ${ID_A}\n`],
    ["a reserved name", doc(ID_A, "None")],
    ["the other reserved name", doc(ID_A, "ALL")],
    ["YAML that does not parse", "id: [unterminated\nname: x: y:\n"],
    ["a non-boolean archived", doc(ID_A, "Garden Planner", "archived: maybe\n")],
    ["a non-boolean dedicated", doc(ID_A, "Garden Planner", "dedicated: sometimes\n")],
  ])("%s", (_label, body) => {
    write("garden.yaml", body);
    expect(names()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("projects/garden.yaml refused"));
  });

  it("refuses a duplicate name, ignoring case, keeping the first file", () => {
    write("a.yaml", doc(ID_A, "Garden Planner"));
    write("b.yaml", doc(ID_B, "garden PLANNER"));
    expect(registry.refreshProjects().projects.map((p) => p.id)).toEqual([ID_A]);
  });

  it("keeps the last good definition of a file whose edit broke it, matched by path", () => {
    write("garden.yaml", doc(ID_A, "Garden Planner", "description: first\n"));
    expect(registry.refreshProjects().byId.get(ID_A)?.description).toBe("first");
    for (const broken of ["id: [oops\n", `id: ${ID_A}\n`, "name: only a name\n", doc("prj_nope", "Garden Planner")]) {
      write("garden.yaml", broken);
      const set = registry.refreshProjects();
      expect(set.byId.get(ID_A)).toMatchObject({ name: "Garden Planner", description: "first" });
      expect(registry.projectRefOf(ID_A).known).toBe(true);
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keeping the last good definition of "Garden Planner"'));
  });

  it("does not keep a definition for a file that never loaded, or one that was deleted", () => {
    write("garden.yaml", "id: nope\nname: x\n");
    expect(names()).toEqual([]);
    write("real.yaml", doc(ID_A, "Real"));
    expect(names()).toEqual(["Real"]);
    fs.rmSync(path.join(dir, "real.yaml"));
    expect(names()).toEqual([]);
    expect(registry.projectRefOf(ID_A)).toMatchObject({ known: false, archived: true });
  });
});

describe("duplicate ids", () => {
  it("keep the first file in lexical order on a fresh boot", () => {
    write("b.yaml", doc(ID_A, "Second"));
    write("a.yaml", doc(ID_A, "First"));
    expect(names()).toEqual(["First"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("projects/b.yaml refused"));
  });

  it("keep the definition already loaded, even when the newcomer sorts first", () => {
    write("z.yaml", doc(ID_A, "Loaded First"));
    expect(names()).toEqual(["Loaded First"]);
    write("a.yaml", doc(ID_A, "Newcomer"));
    expect(names()).toEqual(["Loaded First"]);
  });
});

describe("duplicate names", () => {
  it("refuse the edited file, not the live project, when a hand-edit claims another project's name", () => {
    write("a.yaml", doc(ID_A, "Alpha"));
    write("b.yaml", doc(ID_B, "Beta"));
    expect(names()).toEqual(["Alpha", "Beta"]);
    write("a.yaml", doc(ID_A, "Beta"));
    const set = registry.refreshProjects();
    expect(set.projects.map((p) => `${p.id}=${p.name}`)).toEqual([`${ID_A}=Alpha`, `${ID_B}=Beta`]);
    expect(registry.projectRefOf(ID_B)).toMatchObject({ name: "Beta", known: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("projects/a.yaml refused"));
  });

  it("do the same across a restart, using the name each id was last seen under", () => {
    write("a.yaml", doc(ID_A, "Alpha"));
    write("b.yaml", doc(ID_B, "Beta"));
    registry.refreshProjects();
    write("a.yaml", doc(ID_A, "Beta"));
    registry.resetProjectRegistryForTests(); // a restart keeps project_ids_seen but not the loaded set
    const set = registry.refreshProjects();
    expect(set.byId.get(ID_B)?.name).toBe("Beta");
    expect(set.byId.has(ID_A)).toBe(false);
  });
});

describe("content problems drop only the entry", () => {
  it("drops a missing skill, a bad shared-notes path and a bad working directory, and keeps the project", () => {
    write("garden.yaml", doc(ID_A, "Garden Planner", [
      "skills: [review, gone-skill]",
      "sharedNotes: [knowledge/garden, /etc/passwd, ../outside, docs/shared]",
      "workdirs: [/nonexistent/garden-planner]",
      "",
    ].join("\n")));
    const project = registry.refreshProjects().byId.get(ID_A);
    expect(project).toMatchObject({ skills: ["review"], sharedNotes: ["knowledge/garden", "docs/shared"], workdirs: [] });
    const warnings = logger.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((w) => w.includes('skill "gone-skill"'))).toBe(true);
    expect(warnings.some((w) => w.includes("/etc/passwd"))).toBe(true);
    expect(warnings.some((w) => w.includes("/nonexistent/garden-planner"))).toBe(true);
    expect(warnings.some((w) => w.includes("refused"))).toBe(false);
  });

  it("treats a wrongly typed list as empty, with a warning", () => {
    write("garden.yaml", doc(ID_A, "Garden Planner", "skills: review\n"));
    expect(registry.refreshProjects().byId.get(ID_A)?.skills).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("skills must be a list"));
  });
});

describe("ids seen and renamed files", () => {
  it("keeps membership by id when a file is renamed or moved", () => {
    write("garden.yaml", doc(ID_A, "Garden Planner"));
    expect(registry.refreshProjects().byId.get(ID_A)?.file).toBe("projects/garden.yaml");
    fs.renameSync(path.join(dir, "garden.yaml"), path.join(dir, "renamed.yml"));
    const moved = registry.refreshProjects().byId.get(ID_A);
    expect(moved).toMatchObject({ name: "Garden Planner", file: "projects/renamed.yml" });
  });

  it("reports an id that comes back under a different name, and still loads the file", () => {
    write("garden.yaml", doc(ID_A, "Garden Planner"));
    registry.refreshProjects();
    fs.rmSync(path.join(dir, "garden.yaml"));
    registry.refreshProjects();
    write("other.yaml", doc(ID_A, "Boat Club"));
    const set = registry.refreshProjects();
    expect(set.byId.get(ID_A)?.name).toBe("Boat Club");
    expect(set.notices.get(ID_A)).toEqual(['id previously used by "Garden Planner"']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('id previously used by "Garden Planner"'));
    expect(registry.refreshProjects().notices.get(ID_A)).toEqual(['id previously used by "Garden Planner"']);
  });

  it("does not report an in-place rename as a reused id", () => {
    write("garden.yaml", doc(ID_A, "Garden Planner"));
    registry.refreshProjects();
    write("garden.yaml", doc(ID_A, "Allotment Planner"));
    expect(registry.refreshProjects().notices.size).toBe(0);
    expect(db.prepare("SELECT last_name FROM project_ids_seen WHERE project_id = ?").pluck().get(ID_A)).toBe("Allotment Planner");
  });

  it("reports Todos that name an id with no definition, without refusing anything", () => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO work_item_projects (work_item_id, project_id, added_at) VALUES ('ZZZ-9', ?, ?)").run(ID_B, new Date().toISOString());
    write("garden.yaml", doc(ID_A, "Garden Planner"));
    expect(names()).toEqual(["Garden Planner"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`unknown project id(s) ${ID_B}`));
    db.prepare("DELETE FROM work_item_projects WHERE work_item_id = 'ZZZ-9'").run();
    db.pragma("foreign_keys = ON");
  });
});
