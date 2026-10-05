import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the registry DB at a throwaway dir BEFORE importing it (the path is
// resolved from JINN_HOME at module load), so the suite stays off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-projects-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Membership = typeof import("../project-membership.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let membership: Membership;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

const GARDEN = "prj_0a1b2c3d4e5f";
const BOATS = "prj_1a2b3c4d5e6f";
const refOf = (id: string) => ({ id, name: id === GARDEN ? "Garden Planner" : "Boat Club", archived: id === "prj_aaaaaaaaaaaa", known: id !== "prj_ffffffffffff" });

beforeAll(async () => {
  store = await import("../store.js");
  membership = await import("../project-membership.js");
  migrate = await import("../migrate.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("root-only membership", () => {
  it("holds a row for a top-level Todo and reads it back through its sub-tasks", () => {
    const root = store.createWorkItem({ title: "Root" });
    const sub = store.createWorkItem({ title: "Sub", parentId: root.id });
    membership.setWorkItemProject(root.id, GARDEN, "operator", refOf);
    expect(membership.projectIdOf(root.id)).toBe(GARDEN);
    expect(membership.projectIdOf(sub.id)).toBe(GARDEN);
    expect(db.prepare("SELECT work_item_id FROM work_item_projects").pluck().all()).toEqual([root.id]);
    expect(store.listWorkItems({ project: GARDEN }).map((i) => i.id).sort()).toEqual([root.id, sub.id].sort());
  });

  it("refuses a sub-task, naming its root, and writes nothing", () => {
    const root = store.createWorkItem({ title: "Root" });
    const sub = store.createWorkItem({ title: "Sub", parentId: root.id });
    expect(() => membership.setWorkItemProject(sub.id, GARDEN, "operator", refOf)).toThrow(new RegExp(root.id));
    expect(membership.projectIdOf(sub.id)).toBeNull();
  });

  it("batches refs for a page, with every requested id present", () => {
    const a = store.createWorkItem({ title: "A" });
    const b = store.createWorkItem({ title: "B" });
    membership.setWorkItemProject(a.id, BOATS, "operator", refOf);
    const refs = membership.projectRefs([a.id, b.id], refOf);
    expect(refs.get(a.id)).toMatchObject({ id: BOATS, name: "Boat Club" });
    expect(refs.get(b.id)).toBeNull();
  });

  it("refuses an archived or unknown target and lets a Todo leave one", () => {
    const todo = store.createWorkItem({ title: "Mover" });
    expect(() => membership.setWorkItemProject(todo.id, "prj_aaaaaaaaaaaa", "operator", refOf)).toThrow(/archived/);
    expect(() => membership.setWorkItemProject(todo.id, "prj_ffffffffffff", "operator", refOf)).toThrow(/unknown/);
    membership.setWorkItemProject(todo.id, GARDEN, "operator", refOf);
    expect(membership.setWorkItemProject(todo.id, null, "operator", () => ({ id: GARDEN, name: "x", archived: true, known: false })).changed).toBe(true);
  });

  it("counts Todos per project", () => {
    expect(membership.projectTodoCounts().get(GARDEN)).toBeGreaterThanOrEqual(1);
  });
});

describe("schema", () => {
  it("passes the boot verifier with membership data present", () => {
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
  });

  it("refuses a boot where a sub-task holds a membership row", () => {
    const root = store.createWorkItem({ title: "Root" });
    const sub = store.createWorkItem({ title: "Sub", parentId: root.id });
    db.prepare("INSERT INTO work_item_projects (work_item_id, project_id, added_at) VALUES (?, ?, ?)").run(sub.id, GARDEN, new Date().toISOString());
    try {
      expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow();
    } finally {
      db.prepare("DELETE FROM work_item_projects WHERE work_item_id = ?").run(sub.id);
    }
  });

  it("does not refuse a boot for a project id that has no file", () => {
    const todo = store.createWorkItem({ title: "Orphan" });
    db.prepare("INSERT INTO work_item_projects (work_item_id, project_id, added_at) VALUES (?, ?, ?)").run(todo.id, "prj_ffffffffffff", new Date().toISOString());
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
  });

  it("rejects a malformed project id at the table", () => {
    const todo = store.createWorkItem({ title: "Bad id" });
    expect(() => db.prepare("INSERT INTO work_item_projects (work_item_id, project_id, added_at) VALUES (?, 'garden', ?)").run(todo.id, "now")).toThrow();
  });

  it("heals a registry from before projects shipped by creating both tables at boot", () => {
    const file = path.join(tmp, "pre-projects.db");
    db.exec(`VACUUM INTO '${file}'`);
    const old = new Database(file);
    old.exec("DELETE FROM work_item_projects; DROP TABLE work_item_projects; DROP TABLE project_ids_seen;");
    old.close();
    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");
    const healed = new Database(file);
    try {
      migrate.migrateWorkItemsSchema(healed, "current");
      const tables = healed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('work_item_projects','project_ids_seen')").pluck().all();
      expect((tables as string[]).sort()).toEqual(["project_ids_seen", "work_item_projects"]);
      expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    } finally {
      healed.close();
    }
  });
});
