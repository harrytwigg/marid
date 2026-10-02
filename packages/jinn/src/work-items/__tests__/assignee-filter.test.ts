import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-assignee-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Operator = typeof import("../operator-assignee.js");

let store: Store;
let operator: Operator;
const ids = {} as { operatorOwned: string; employeeOwned: string; nobody: string };

beforeAll(async () => {
  store = await import("../store.js");
  operator = await import("../operator-assignee.js");
  const mk = (title: string, assignee?: string) =>
    store.createWorkItem({ title, createdBy: "operator", status: "backlog", ...(assignee ? { assignee } : {}) }).id;
  ids.operatorOwned = mk("owned by the operator", operator.OPERATOR_ASSIGNEE);
  ids.employeeOwned = mk("owned by an employee", "some-employee");
  ids.nobody = mk("owned by nobody");
});

const idsFor = (assignee?: string) =>
  store.queryWorkItems({ ...(assignee ? { assignee } : {}), limit: 100 }).workItems.map((item) => item.id).sort();

describe("the assignee filter accepts the operator and the no-assignee sentinel", () => {
  it("matches only the operator's Todos for the operator assignee", () => {
    expect(idsFor(operator.OPERATOR_ASSIGNEE)).toEqual([ids.operatorOwned]);
  });

  it("matches only Todos with no assignee for the unassigned sentinel", () => {
    expect(idsFor(operator.UNASSIGNED_FILTER)).toEqual([ids.nobody]);
  });

  it("still matches a named employee exactly, and everything when unset", () => {
    expect(idsFor("some-employee")).toEqual([ids.employeeOwned]);
    expect(idsFor()).toEqual([ids.operatorOwned, ids.employeeOwned, ids.nobody].sort());
  });

  it("composes with the status filter and reports an exact total", () => {
    const page = store.queryWorkItems({ assignee: operator.UNASSIGNED_FILTER, status: "backlog", limit: 100 });
    expect(page.total).toBe(1);
    expect(store.queryWorkItems({ assignee: operator.UNASSIGNED_FILTER, status: "done", limit: 100 }).total).toBe(0);
  });
});
