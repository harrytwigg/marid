import { call, context, home, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { noAutoStartReason } from "../../board-walk/board.js";
import { todoVerbs } from "../../plugins/host/todos.js";
import { createSession } from "../../sessions/registry.js";
import { DepartmentBoundaryError } from "../../work-items/department-scope.js";
import { createWorkItem, getWorkItem, linkSession, listWorkItems } from "../../work-items/store.js";
import { startTodoDispatcher } from "../todo-dispatch.js";
import { refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * FR-015 at the entries that reach the writers (the PATCH and assign routes, delegation's
 * create-already-assigned path, plugin creates) and at the paths that start work without
 * writing the assignee (the link, the Dispatcher, the board walk).
 */

beforeAll(async () => { await startScopedHarness(); });
beforeEach(() => {
  resetDepartmentFixtures();
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
  writeDepartmentFile("other-side", "name: other-side\nscope: dedicated\n");
  writeEmployeeFile("side-project", "side-dev");
  writeEmployeeFile("other-side", "other-dev");
  writeEmployeeFile("engineering", "eng-dev");
  refreshOrg(context.getConfig());
});

const todo = (department: string | null) => createWorkItem({ title: "entry", ...(department ? { department } : {}) });
const boundary = (response: { status: number; body: any }) => expect({ status: response.status, code: response.body.code }).toEqual({ status: 409, code: "department-boundary" });

describe.each([
  ["PATCH /api/work-items/:id", (id: string, assignee: string) => call("PATCH", `/api/work-items/${id}`, { assignee, expectedVersion: getWorkItem(id)!.version })],
  ["POST /api/work-items/:id/assign", (id: string, assignee: string) => call("POST", `/api/work-items/${id}/assign`, { assignee })],
] as const)("%s", (_route, write) => {
  it.each([
    ["side-dev", "engineering"], ["side-dev", "other-side"], ["eng-dev", "other-side"], ["other-dev", "side-project"],
  ])("refuses %s on a Todo in %s with a boundary error, and writes nothing", async (assignee, department) => {
    const item = todo(department);
    boundary(await write(item.id, assignee));
    expect(getWorkItem(item.id)?.assignee).toBeNull();
  });

  it.each([["side-dev", "side-project"], ["eng-dev", "side-project"], ["other-dev", "other-side"], ["@operator", "other-side"]])("lets %s hold a Todo in %s", async (assignee, department) => {
    const item = todo(department);
    expect((await write(item.id, assignee)).status).toBe(200);
    expect(getWorkItem(item.id)?.assignee).toBe(assignee);
  });
});

describe("delegation that creates an already-assigned Todo", () => {
  const delegate = (employee: string) => call("POST", "/api/delegations", { employee, task: "work", title: "delegated" });

  it("lands a scoped member's Todo in its department, and a dedicated member's in its own", async () => {
    for (const [employee, department] of [["side-dev", "side-project"], ["other-dev", "other-side"], ["eng-dev", "engineering"]]) {
      const made = await delegate(employee);
      expect({ employee, status: made.status }).toEqual({ employee, status: 201 });
      const item = getWorkItem(made.body.workItemId)!;
      expect({ employee, department: item.department, assignee: item.assignee }).toEqual({ employee, department, assignee: employee });
    }
  });

  describe("under a closed department policy", () => {
    const config = path.join(home, "config.yaml");
    const policy = "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: Acme\n  companyPrefix: ACM\ngateway:\n  port: 8061\n  host: 127.0.0.1\n  todoDepartments:\n    allowed: [general, side-project]\n    default: general\n";
    beforeEach(() => fs.writeFileSync(config, policy));
    afterEach(() => fs.rmSync(config, { force: true }));

    it("refuses an employee who may not hold the default department's Todo, and mints nothing", async () => {
      const before = listWorkItems({}).length;
      const refused = await delegate("side-dev");
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.body.workItemId).toBeUndefined();
      expect(listWorkItems({}).length).toBe(before);
      expect((await delegate("eng-dev")).status).toBe(201);
    });

    // Finding: the refusal is a DepartmentBoundaryError, which the mint's catch turns into a
    // 500 "the work item could not be minted", where every other writer route answers 409
    // with `code: "department-boundary"` and the reason. Flips red when it is mapped.
    it("answers it as the other entries do: 409 with the boundary code", async () => {
      const refused = await delegate("side-dev");
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: "department-boundary" });
    });
  });
});

describe("a plugin create", () => {
  const create = (assignee: string, department: string) => todoVerbs("demo-plugin", "plugin:demo-plugin").create({ title: "from a plugin", assignee, department });

  it("is held to the same rule as any writer", () => {
    expect(create("eng-dev", "side-project").assignee).toBe("eng-dev");
    expect(() => create("side-dev", "engineering")).toThrow(DepartmentBoundaryError);
    expect(() => create("eng-dev", "other-side")).toThrow(DepartmentBoundaryError);
    expect(create("@operator", "other-side").assignee).toBe("@operator");
  });
});

describe("linkSession", () => {
  const sessionOfEmployee = (employee: string) => createSession({ engine: "claude", source: "web", sourceRef: `web:${employee}:${Math.random()}`, employee });

  it("refuses an execute link for an employee who may not hold the Todo, and allows a review link", () => {
    const dedicated = todo("other-side");
    expect(() => linkSession(dedicated.id, sessionOfEmployee("eng-dev").id, "operator", "execute")).toThrow(DepartmentBoundaryError);
    expect(() => linkSession(dedicated.id, sessionOfEmployee("eng-dev").id, "operator", "review")).not.toThrow();
    expect(() => linkSession(dedicated.id, sessionOfEmployee("other-dev").id, "operator", "execute")).not.toThrow();
    expect(() => linkSession(todo("engineering").id, sessionOfEmployee("side-dev").id, "operator", "execute")).toThrow(DepartmentBoundaryError);
    expect(() => linkSession(todo("side-project").id, sessionOfEmployee("eng-dev").id, "operator", "execute")).not.toThrow();
  });
});

describe("a holding a hand edit left outside the rules", () => {
  /** eng-dev holds a Todo in a scoped department; the operator then hand-edits the department dedicated. */
  function handEdited() {
    const item = createWorkItem({ title: "held", department: "side-project", assignee: "eng-dev" });
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    refreshOrg(context.getConfig());
    return getWorkItem(item.id)!;
  }

  it("starts nothing in the Dispatcher: 409, naming the Todo", () => {
    const item = handEdited();
    const started = startTodoDispatcher(item, context);
    expect(started.ok).toBe(false);
    expect(started).toMatchObject({ status: 409, body: { error: expect.stringContaining(`${item.id} is in dedicated department "side-project"`) } });
  });

  it("is skipped by the board walk, with the same reason", () => {
    const clean = createWorkItem({ title: "clean", department: "engineering", assignee: "eng-dev" });
    expect(noAutoStartReason(clean)).toBeUndefined();
    expect(noAutoStartReason(handEdited())).toMatch(/is in dedicated department "side-project", which only its own members can hold; eng-dev is not one/);
  });

  it("is refused by the dispatch route too", async () => {
    const item = handEdited();
    const refused = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
    expect(refused.status).toBe(409);
  });
});
