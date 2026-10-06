import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { context, home, startScopedHarness } from "./department-scope-harness.js";
import { departmentScopeSections } from "../../sessions/context/department-scope.js";

/**
 * FR-027: a scoped department's skill allow-list applies to a Todo's `dispatchConfig.skills`
 * (set time and dispatch time) and to the prompt. The harness installs `dev-workflow` and
 * `browser-use`; `side-project` allows only the first.
 */

let dispatch: typeof import("../../work-items/dispatch-config.js");
let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
  dispatch = await import("../../work-items/dispatch-config.js");
});

const set = (id: string, skills: string[]) => dispatch.setTodoDispatchConfig(id, { skills }, context.getConfig());

describe("setting a Todo's skills", () => {
  it("accepts an allowed skill on a Todo in a scoped department, and refuses another, naming what is offered", () => {
    const todo = workItems.createWorkItem({ title: "skills-in-scope", department: "side-project", assignee: "side-dev" });
    expect(set(todo.id, ["dev-workflow"]).ok).toBe(true);
    const refused = set(todo.id, ["browser-use"]);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("unknown skill: browser-use") });
    expect((refused as { error: string }).error).toContain("this Todo's department offers only: dev-workflow");
  });

  it("applies to a sub-task through its root's department", () => {
    const root = workItems.createWorkItem({ title: "skills-root", department: "side-project", assignee: "side-dev" });
    const child = workItems.createWorkItem({ title: "skills-child", parentId: root.id, assignee: "side-dev" });
    expect(set(child.id, ["browser-use"]).ok).toBe(false);
    expect(set(child.id, ["dev-workflow"]).ok).toBe(true);
  });

  it("leaves a Todo in an open department free to name any installed skill", () => {
    const todo = workItems.createWorkItem({ title: "skills-open", department: "engineering", assignee: "eng-dev" });
    expect(set(todo.id, ["browser-use", "dev-workflow"]).ok).toBe(true);
  });
});

describe("dispatching a Todo's skills", () => {
  it("reads a scoped assignee's skills from its stage directory's copies, and anyone else's from skills/", () => {
    const scoped = workItems.createWorkItem({ title: "dispatch-scoped", department: "side-project", assignee: "side-dev" });
    const unscoped = workItems.createWorkItem({ title: "dispatch-unscoped", department: "side-project", assignee: "eng-dev" });
    set(scoped.id, ["dev-workflow"]);
    set(unscoped.id, ["dev-workflow"]);
    const prefix = (id: string) => (dispatch.resolveTodoDispatch(id) as { ok: true; preamble: { prefix: string } }).preamble.prefix;
    expect(prefix(scoped.id)).toBe("Read and follow .claude/skills/dev-workflow/SKILL.md before you start.\n\n");
    expect(prefix(unscoped.id)).toBe("Read and follow skills/dev-workflow/SKILL.md before you start.\n\n");
  });

  it("refuses a Todo whose stored skills the department no longer offers", () => {
    const todo = workItems.createWorkItem({ title: "dispatch-dropped", department: "side-project", assignee: "side-dev" });
    set(todo.id, ["dev-workflow"]);
    fs.writeFileSync(path.join(home, "org", "side-project", "department.yaml"), "name: side-project\nscope: scoped\nskills: []\n");
    return import("../department-registry.js").then(({ refreshDepartments }) => {
      refreshDepartments();
      expect(dispatch.resolveTodoDispatch(todo.id)).toMatchObject({
        ok: false,
        error: expect.stringContaining("this Todo's department offers no skills"),
      });
      fs.writeFileSync(path.join(home, "org", "side-project", "department.yaml"), "name: side-project\nscope: scoped\nskills: [dev-workflow]\n");
      refreshDepartments();
    });
  });
});

describe("the prompt of a scoped session", () => {
  const line = (department: string) => departmentScopeSections({ employee: { name: department === "side-project" ? "side-dev" : "eng-dev" } })[0]?.content;

  it("names the skills the department offers", () => {
    expect(line("side-project")).toContain("Company skills available to you: dev-workflow (in `.claude/skills/`). No other company skill is offered.");
  });

  it("is empty for an unscoped employee", () => {
    expect(line("engineering")).toBeUndefined();
  });
});
