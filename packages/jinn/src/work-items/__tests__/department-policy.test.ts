import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// JINN_HOME before the store loads, so the suite never touches the live DB.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-dept-policy-"));
process.env.JINN_HOME = home;

const BASE_CONFIG = "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: Acme\n  companyPrefix: ACM\n";
const CLOSED = `${BASE_CONFIG}gateway:\n  port: 7777\n  host: 127.0.0.1\n  todoDepartments:\n    allowed: [labs, jinn, general]\n    default: general\n`;

function writeConfig(yaml: string): void {
  fs.writeFileSync(path.join(home, "config.yaml"), yaml, "utf8");
}

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Departments = typeof import("../departments.js");
type Policy = typeof import("../../shared/todo-departments-config.js");
let store: Store;
let transitions: Transitions;
let departments: Departments;
let policy: Policy;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  writeConfig(BASE_CONFIG);
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  departments = await import("../departments.js");
  policy = await import("../../shared/todo-departments-config.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("gateway.todoDepartments config shape", () => {
  it("accepts unset and a well-formed policy", () => {
    expect(policy.todoDepartmentsProblems(undefined)).toEqual([]);
    expect(policy.todoDepartmentsProblems({ allowed: ["labs", "jinn", "general"], default: "general" })).toEqual([]);
    expect(policy.todoDepartmentsProblems({ allowed: ["general"] })).toEqual([]);
  });

  it.each([
    ["a scalar", "general"],
    ["an empty list", { allowed: [] }],
    ["a non-slug entry", { allowed: ["Labs"] }],
    ["a repeated slug", { allowed: ["jinn", "jinn"] }],
    ["a default outside the list", { allowed: ["jinn"], default: "general" }],
  ])("refuses %s", (_name, value) => {
    expect(policy.todoDepartmentsProblems(value)).not.toEqual([]);
  });
});

describe("open departments (no policy) keep the historical behaviour", () => {
  beforeEach(() => writeConfig(BASE_CONFIG));

  it("assignment moves the Todo into the assignee's department", () => {
    const item = store.createWorkItem({ title: "open move", department: "jinn" });
    const assigned = transitions.assignWorkItem(item.id, "worker", "general", "operator");
    expect(assigned?.department).toBe("general");
  });

  it("a create without a department stays in the company namespace", () => {
    const item = store.createWorkItem({ title: "open unclassified" });
    expect(item.department).toBeNull();
    expect(item.id.startsWith("ACM-")).toBe(true);
  });

  it("any department slug is accepted", () => {
    expect(store.createWorkItem({ title: "open anything", department: "whatever" }).department).toBe("whatever");
  });
});

describe("closed departments (gateway.todoDepartments)", () => {
  beforeEach(() => writeConfig(CLOSED));

  it("refuses a create into an unlisted department", () => {
    expect(() => store.createWorkItem({ title: "closed stray", department: "engineering" }))
      .toThrow(policy.TodoDepartmentNotAllowedError);
  });

  it("files an unclassified create under the default, with the default's prefix", () => {
    const item = store.createWorkItem({ title: "closed default" });
    expect(item.department).toBe("general");
    expect(item.id.startsWith("GEN-")).toBe(true);
    expect(store.createWorkItem({ title: "closed explicit null", department: null }).department).toBe("general");
  });

  it("mints a listed department's prefix on first use", () => {
    const item = store.createWorkItem({ title: "first labs", department: "labs" });
    expect(item.id.startsWith("LAB-")).toBe(true);
  });

  it("a sub-task inherits a parent classified before the policy", () => {
    writeConfig(BASE_CONFIG);
    const parent = store.createWorkItem({ title: "legacy parent", department: "legacy-dept" });
    writeConfig(CLOSED);
    const child = store.createWorkItem({ title: "legacy child", parentId: parent.id });
    expect(child.department).toBe("legacy-dept");
  });

  it("assignment keeps the department instead of following the assignee", () => {
    const item = store.createWorkItem({ title: "closed keep", department: "jinn" });
    const assigned = transitions.assignWorkItem(item.id, "worker", "general", "operator");
    expect(assigned?.department).toBe("jinn");
    expect(assigned?.assignee).toBe("worker");
    expect(assigned?.status).toBe("assigned");
  });

  it("assignment fills an unclassified Todo with the default, never the assignee's org department", () => {
    writeConfig(BASE_CONFIG);
    const item = store.createWorkItem({ title: "pre-policy unclassified" });
    writeConfig(CLOSED);
    const assigned = transitions.assignWorkItem(item.id, "worker", "operations", "operator");
    expect(assigned?.department).toBe("general");
  });

  it("the metadata pen refuses an unlisted department and accepts a listed one", () => {
    const item = store.createWorkItem({ title: "closed pen", department: "general" });
    expect(() => store.updateWorkItemConditional(item.id, { department: "engineering" }, { expectedVersion: item.version, actor: "operator" }))
      .toThrow(policy.TodoDepartmentNotAllowedError);
    const moved = store.updateWorkItemConditional(item.id, { department: "labs" }, { expectedVersion: item.version, actor: "operator" });
    expect(moved?.item.department).toBe("labs");
    expect(moved?.item.id).toBe(item.id);
  });

  it("the metadata pen tolerates re-sending a pre-policy department unchanged", () => {
    writeConfig(BASE_CONFIG);
    const item = store.createWorkItem({ title: "legacy pen", department: "legacy-pen-dept" });
    writeConfig(CLOSED);
    const result = store.updateWorkItemConditional(item.id, { department: "legacy-pen-dept", title: "renamed" }, { expectedVersion: item.version, actor: "operator" });
    expect(result?.item.title).toBe("renamed");
    expect(result?.item.department).toBe("legacy-pen-dept");
  });

  it("the listing marks departments outside the policy unselectable", () => {
    const listed = departments.listDepartmentsWithCounts(db, ["labs", "jinn", "general"]);
    expect(listed.find((d) => d.slug === "general")?.selectable).toBe(true);
    expect(listed.find((d) => d.slug === "legacy-dept")?.selectable).toBe(false);
    expect(departments.listDepartmentsWithCounts(db).every((d) => d.selectable)).toBe(true);
  });
});
