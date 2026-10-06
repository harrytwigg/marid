import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, call, context, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { generateStageFileSet } from "../department-stage/file-set.js";
import { skillRefusal } from "../../shared/skill-inspection.js";

/**
 * FR-020a, FR-027: a skill that holds a symlink is refused when the stage directory is
 * generated, and so it is refused where the department is shown and where a Todo's skills
 * are validated, with the same reason. The harness installs `dev-workflow` and `browser-use`.
 */

const skills = path.join(home, "skills");
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-symlink-target-"));
const SLUG = "side-project";
const yaml = (names: string[]) => `name: ${SLUG}\nscope: scoped\nskills: [${names.join(", ")}]\n`;

let dispatch: typeof import("../../work-items/dispatch-config.js");
let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let reload: () => void;

function skill(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(skills, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** `side-project` allows exactly `names`, and the org is read again. */
function allow(...names: string[]): void {
  fs.writeFileSync(path.join(home, "org", SLUG, "department.yaml"), yaml(names));
  reload();
}

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
  dispatch = await import("../../work-items/dispatch-config.js");
  const registry = await import("../department-registry.js");
  reload = () => registry.refreshDepartments();
  fs.writeFileSync(path.join(outside, "secret.txt"), "not a skill file\n");
  skill("clean-skill", { "notes/extra.md": "fine" });
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(skill("linked-file"), "secret.txt"));
  fs.symlinkSync(outside, path.join(skill("linked-folder"), "reference"));
  fs.symlinkSync(path.join(outside, "nowhere"), path.join(skill("dangling-link", { "a/b.md": "x" }), "a", "dangling"));
  fs.rmSync(path.join(skills, "linked-skill-dir"), { recursive: true, force: true });
  fs.symlinkSync(path.join(skills, "clean-skill"), path.join(skills, "linked-skill-dir"));
});

afterAll(() => {
  allow("dev-workflow");
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("what makes a skill refused", () => {
  it.each([
    ["a link to a file", "linked-file", "it contains a symlink (secret.txt)"],
    ["a link to a folder", "linked-folder", "it contains a symlink (reference)"],
    ["a dangling link, however deep", "dangling-link", "it contains a symlink (a/dangling)"],
    ["a skill that is itself a link", "linked-skill-dir", "it is not a directory"],
  ])("refuses %s, saying why", (_label, name, reason) => {
    expect(skillRefusal(path.join(skills, name))).toBe(reason);
  });

  it("accepts a plain skill, nested files included", () => {
    expect(skillRefusal(path.join(skills, "clean-skill"))).toBeNull();
    expect(skillRefusal(path.join(skills, "dev-workflow"))).toBeNull();
  });

  it("refuses a skill with no SKILL.md, and one that is not there", () => {
    fs.mkdirSync(path.join(skills, "empty-skill"), { recursive: true });
    expect(skillRefusal(path.join(skills, "empty-skill"))).toBe("it has no SKILL.md");
    expect(skillRefusal(path.join(skills, "never-installed"))).toMatch(/^it could not be read: /);
  });

  it("is the judgement the stage generator makes: it refuses the same skills, for the same reasons", () => {
    const names = ["clean-skill", "linked-file", "linked-folder", "dangling-link", "linked-skill-dir", "empty-skill"];
    const { files, refused } = generateStageFileSet({ home, slug: SLUG, definition: { skills: names, instructions: "department" } });
    for (const name of names) {
      const reason = refused.find((entry) => entry.skill === name)?.reason ?? null;
      expect({ name, reason }).toEqual({ name, reason: skillRefusal(path.join(skills, name)) });
    }
    expect([...files.keys()].some((rel) => rel.startsWith(".claude/skills/clean-skill/"))).toBe(true);
    expect([...files.keys()].some((rel) => rel.startsWith(".claude/skills/linked-file/"))).toBe(false);
  });
});

describe("the department panel's read", () => {
  it("leaves a refused skill out of the offered ones and names it, with why", async () => {
    allow("dev-workflow", "clean-skill", "linked-file", "linked-folder");
    const { body } = await call("GET", `/api/departments/${SLUG}`);
    expect(body.department.skills).toEqual(["dev-workflow", "clean-skill"]);
    expect(body.department.skillProblems).toEqual([
      { skill: "linked-file", reason: "it contains a symlink (secret.txt)" },
      { skill: "linked-folder", reason: "it contains a symlink (reference)" },
    ]);
  });

  it("follows the disk, not the last scan: a link added or removed shows at once", async () => {
    allow("dev-workflow", "clean-skill");
    expect((await call("GET", `/api/departments/${SLUG}`)).body.department.skillProblems).toEqual([]);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(skills, "clean-skill", "added-later"));
    try {
      const { body } = await call("GET", `/api/departments/${SLUG}`);
      expect(body.department.skills).toEqual(["dev-workflow"]);
      expect(body.department.skillProblems).toEqual([{ skill: "clean-skill", reason: "it contains a symlink (added-later)" }]);
    } finally {
      fs.rmSync(path.join(skills, "clean-skill", "added-later"));
    }
    expect((await call("GET", `/api/departments/${SLUG}`)).body.department.skills).toEqual(["dev-workflow", "clean-skill"]);
  });

  it("has no problems for an allow-list of plain skills", async () => {
    allow("dev-workflow");
    expect((await call("GET", `/api/departments/${SLUG}`)).body.department).toMatchObject({ skills: ["dev-workflow"], skillProblems: [] });
  });
});

describe("a Todo's skills (dispatchConfig.skills)", () => {
  const set = (id: string, names: string[]) => dispatch.setTodoDispatchConfig(id, { skills: names }, context.getConfig());

  it("refuses a refused skill on a Todo in the scoped department, naming it and why, and still accepts a plain one", () => {
    allow("dev-workflow", "clean-skill", "linked-file");
    const todo = workItems.createWorkItem({ title: "skill-symlink-set", department: SLUG, assignee: "side-dev" });
    const refused = set(todo.id, ["linked-file"]);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toContain("skill linked-file cannot be used here: it contains a symlink (secret.txt)");
    expect((refused as { error: string }).error).not.toContain("unknown skill");
    expect(set(todo.id, ["dev-workflow", "clean-skill"]).ok).toBe(true);
    expect(set(todo.id, ["dev-workflow", "linked-file"]).ok).toBe(false);
  });

  it("names every refused skill in one answer", () => {
    allow("dev-workflow", "linked-file", "linked-folder");
    const todo = workItems.createWorkItem({ title: "skill-symlink-both", department: SLUG, assignee: "side-dev" });
    const error = (set(todo.id, ["linked-file", "linked-folder"]) as { error: string }).error;
    expect(error).toContain("skill linked-file cannot be used here: it contains a symlink (secret.txt)");
    expect(error).toContain("skill linked-folder cannot be used here: it contains a symlink (reference)");
  });

  it("leaves a skill not on the list as an unknown one, as before", () => {
    allow("dev-workflow");
    const todo = workItems.createWorkItem({ title: "skill-symlink-unlisted", department: SLUG, assignee: "side-dev" });
    expect(set(todo.id, ["linked-file"])).toMatchObject({ ok: false, error: expect.stringContaining("unknown skill: linked-file") });
  });

  it("does not touch a Todo outside a scoped department: its sessions read skills/ itself", () => {
    allow("dev-workflow");
    const todo = workItems.createWorkItem({ title: "skill-symlink-open", department: "engineering", assignee: "eng-dev" });
    expect(set(todo.id, ["linked-file", "linked-folder"]).ok).toBe(true);
  });

  it("refuses a scoped session's own request the same way", async () => {
    allow("dev-workflow", "linked-file");
    const todo = workItems.createWorkItem({ title: "skill-symlink-route", department: SLUG, assignee: "side-dev" });
    const scoped = as((await sessionOf("side-dev")).id);
    const refused = await scoped("PUT", `/api/work-items/${todo.id}/dispatch-config`, { skills: ["linked-file"] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("skill linked-file cannot be used here: it contains a symlink (secret.txt)");
    expect((await scoped("PUT", `/api/work-items/${todo.id}/dispatch-config`, { skills: ["dev-workflow"] })).status).toBe(200);
  });

  it("refuses at dispatch a stored skill that gained a link since, and says so", () => {
    allow("dev-workflow", "clean-skill");
    const todo = workItems.createWorkItem({ title: "skill-symlink-stored", department: SLUG, assignee: "side-dev" });
    expect(set(todo.id, ["clean-skill"]).ok).toBe(true);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(skills, "clean-skill", "added-later"));
    try {
      const result = dispatch.resolveTodoDispatch(todo.id);
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain("clean-skill: it contains a symlink (added-later)");
    } finally {
      fs.rmSync(path.join(skills, "clean-skill", "added-later"));
    }
    expect(dispatch.resolveTodoDispatch(todo.id).ok).toBe(true);
  });
});

describe("writing the allow-list", () => {
  it("refuses a PATCH that adds a refused skill, and writes nothing", async () => {
    allow("dev-workflow");
    const before = fs.readFileSync(path.join(home, "org", SLUG, "department.yaml"), "utf-8");
    const refused = await call("PATCH", `/api/departments/${SLUG}`, { skills: ["dev-workflow", "linked-folder"] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('"linked-folder" cannot be copied to a stage directory: it contains a symlink (reference)');
    expect(fs.readFileSync(path.join(home, "org", SLUG, "department.yaml"), "utf-8")).toBe(before);
    expect((await call("PATCH", `/api/departments/${SLUG}`, { skills: ["dev-workflow", "clean-skill"] })).status).toBe(200);
  });
});
