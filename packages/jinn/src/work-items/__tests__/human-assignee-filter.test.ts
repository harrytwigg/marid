import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-person-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");

let store: Store;
let UNASSIGNED: string;
const ids = {} as Record<"bothSet" | "personOnly" | "agentOnly" | "operatorOnly" | "otherPersonAgent" | "neither", string>;

beforeAll(async () => {
  store = await import("../store.js");
  const operator = await import("../operator-assignee.js");
  const { writeTodoPerson } = await import("../todo-people.js");
  const { initDb } = await import("../../shared/db.js");
  UNASSIGNED = operator.UNASSIGNED_FILTER;
  const db = initDb();
  const mk = (title: string, assignee?: string) =>
    store.createWorkItem({ title, createdBy: "operator", status: "backlog", ...(assignee ? { assignee } : {}) }).id;
  const person = (id: string, who: string) => writeTodoPerson(db, id, who, "operator", "2026-01-01T00:00:00.000Z");
  // The person slot: a stored person, or the operator when the agent slot says so. The agent slot: an employee.
  ids.bothSet = mk("a person and an agent", "some-employee");
  person(ids.bothSet, "user:u1");
  ids.personOnly = mk("a person, no agent");
  person(ids.personOnly, "user:u1");
  ids.agentOnly = mk("an agent, no person", "some-employee");
  ids.operatorOnly = mk("the operator, as the agent slot", operator.OPERATOR_ASSIGNEE);
  ids.otherPersonAgent = mk("another person and the same agent", "some-employee");
  person(ids.otherPersonAgent, "user:u2");
  ids.neither = mk("nobody");
});

const idsFor = (filter: { assignee?: string; humanAssignee?: string }) =>
  store.queryWorkItems({ ...filter, limit: 100 }).workItems.map((item) => item.id).sort();
const sorted = (...list: string[]) => [...list].sort();

describe("the person filter reads the person slot", () => {
  it("matches a named person exactly", () => {
    expect(idsFor({ humanAssignee: "user:u1" })).toEqual(sorted(ids.bothSet, ids.personOnly));
    expect(idsFor({ humanAssignee: "user:u2" })).toEqual([ids.otherPersonAgent]);
    expect(idsFor({ humanAssignee: "user:nobody" })).toEqual([]);
  });

  it("matches the operator whether stored or implied by the agent slot, as the list reads the field", () => {
    expect(idsFor({ humanAssignee: "@operator" })).toEqual([ids.operatorOnly]);
    expect(store.getWorkItem(ids.operatorOnly)?.humanAssignee).toBe("@operator");
  });

  it("@unassigned matches Todos with no person, whatever their agent", () => {
    expect(idsFor({ humanAssignee: UNASSIGNED })).toEqual(sorted(ids.agentOnly, ids.neither));
  });

  it("matches the same Todos as the humanAssignee each of them reads", () => {
    for (const who of ["user:u1", "user:u2", "@operator", UNASSIGNED]) {
      const expected = store.queryWorkItems({ limit: 100 }).workItems
        .filter((item) => (who === UNASSIGNED ? item.humanAssignee === null : item.humanAssignee === who))
        .map((item) => item.id).sort();
      expect(idsFor({ humanAssignee: who })).toEqual(expected);
    }
  });
});

describe("the person and agent filters are independent and AND together", () => {
  it("agent alone ignores the person slot", () => {
    expect(idsFor({ assignee: "some-employee" })).toEqual(sorted(ids.bothSet, ids.agentOnly, ids.otherPersonAgent));
  });

  it("both set keeps only the Todos matching both", () => {
    expect(idsFor({ humanAssignee: "user:u1", assignee: "some-employee" })).toEqual([ids.bothSet]);
    expect(idsFor({ humanAssignee: "user:u2", assignee: "some-employee" })).toEqual([ids.otherPersonAgent]);
    expect(idsFor({ humanAssignee: "user:u2", assignee: "other-employee" })).toEqual([]);
  });

  it("a person with no agent, and an agent with no person", () => {
    expect(idsFor({ humanAssignee: "user:u1", assignee: UNASSIGNED })).toEqual([ids.personOnly]);
    expect(idsFor({ humanAssignee: UNASSIGNED, assignee: "some-employee" })).toEqual([ids.agentOnly]);
    expect(idsFor({ humanAssignee: UNASSIGNED, assignee: UNASSIGNED })).toEqual([ids.neither]);
  });

  it("composes with status and reports an exact total", () => {
    const page = store.queryWorkItems({ humanAssignee: "user:u1", status: "backlog", limit: 100 });
    expect(page.total).toBe(2);
    expect(store.queryWorkItems({ humanAssignee: "user:u1", status: "done", limit: 100 }).total).toBe(0);
  });

  it("counts as a filter for search", () => {
    expect(store.searchWorkItems({ humanAssignee: "user:u1" }).map((item) => item.id).sort()).toEqual(sorted(ids.bothSet, ids.personOnly));
  });
});
