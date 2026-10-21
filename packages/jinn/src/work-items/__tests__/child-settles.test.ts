import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-child-settles-"));
process.env.JINN_HOME = tmp;

let migrate: typeof import("../migrate.js");
let settles: typeof import("../child-settles.js");
let store: typeof import("../store.js");
let transitions: typeof import("../transitions.js");
let archive: typeof import("../archive.js");
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  migrate = await import("../migrate.js");
  settles = await import("../child-settles.js");
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  archive = await import("../archive.js");
  db = (await import("../../shared/db.js")).initDb();
});

const shape = (sql: string | undefined) =>
  (sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

function storedSql(database: import("better-sqlite3").Database, type: "table" | "index", name: string): string | undefined {
  return (database.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as { sql: string } | undefined)?.sql;
}

describe("work_item_child_settles is additive", () => {
  it("is created on a fresh database at its frozen shape, with its partial index, and verifies", () => {
    const database = new Database(path.join(tmp, "fresh.db"));
    migrate.migrateWorkItemsSchema(database, "absent");
    expect(shape(storedSql(database, "table", "work_item_child_settles"))).toBe(shape(settles.WORK_ITEM_CHILD_SETTLES_TABLE_DDL));
    expect(storedSql(database, "index", "idx_child_settles_pending")).toMatch(/WHERE flushed_at IS NULL/i);
    expect(() => migrate.verifyCurrentWorkItemSchema(database)).not.toThrow();
    database.close();
  });

  it("boots an existing v2 database that lacks it, without a rebuild", () => {
    const file = path.join(tmp, "heal.db");
    const first = new Database(file);
    migrate.migrateWorkItemsSchema(first, "absent");
    first.exec("DROP TABLE work_item_child_settles");
    first.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const reopened = new Database(file);
    migrate.registerWorkItemIdentityFunctions(reopened);
    expect(migrate.migrateWorkItemsSchema(reopened).rebuilt).toBe(false);
    migrate.verifyCurrentWorkItemSchema(reopened);
    expect(reopened.prepare("SELECT count(*) AS n FROM work_item_child_settles").get()).toEqual({ n: 0 });
    expect(storedSql(reopened, "index", "idx_child_settles_pending")).toBeDefined();
    reopened.close();
  });

  it("the verifier refuses a table whose shape drifted", () => {
    const database = new Database(path.join(tmp, "drift.db"));
    migrate.migrateWorkItemsSchema(database, "absent");
    database.exec("DROP TABLE work_item_child_settles");
    database.exec("CREATE TABLE work_item_child_settles (id INTEGER PRIMARY KEY, parent_id TEXT)");
    expect(() => migrate.verifyCurrentWorkItemSchema(database)).toThrow(/Unsupported prerelease/);
    database.close();
  });
});

describe("transition() records a child settling", () => {
  const rows = (childId: string) => db.prepare("SELECT * FROM work_item_child_settles WHERE child_id = ? ORDER BY id").all(childId) as Array<Record<string, unknown>>;
  const parent = (status: "executing" | "backlog" = "executing") => store.createWorkItem({ title: "parent", status, source: "session", assignee: "tree-owner" });
  const child = (parentId: string, status: "executing" | "backlog" | "in_review" | "blocked" = "executing") =>
    store.createWorkItem({ title: "child", status, source: "session", assignee: "tree-worker", parentId });

  it.each(["in_review", "blocked", "done", "cancelled"] as const)("a child moved to %s writes one row with the move", (to) => {
    const kid = child(parent().id);
    const { event } = transitions.transition(kid.id, to, "session:abc", { human: true });
    expect(rows(kid.id)).toEqual([expect.objectContaining({
      parent_id: kid.parentId,
      child_id: kid.id,
      event_id: event!.id,
      from_status: "executing",
      to_status: to,
      actor: "session:abc",
      flushed_at: null,
      outcome: null,
      delivery_id: null,
    })]);
  });

  it.each(["executing", "backlog"] as const)("a move to %s is not a settle", (to) => {
    const kid = child(parent().id, "blocked");
    transitions.transition(kid.id, to, "operator", { human: true });
    expect(rows(kid.id)).toEqual([]);
  });

  it("a root Todo settling writes nothing", () => {
    const root = parent();
    transitions.transition(root.id, "in_review", "board-walk");
    expect(db.prepare("SELECT count(*) AS n FROM work_item_child_settles WHERE child_id = ?").get(root.id)).toEqual({ n: 0 });
  });

  it("a move that changes nothing writes nothing", () => {
    const kid = child(parent().id, "blocked");
    transitions.transition(kid.id, "blocked", "board-walk");
    expect(rows(kid.id)).toEqual([]);
  });

  it("a cascade close records every child it closes", () => {
    const top = parent();
    const mid = child(top.id);
    const leaf = store.createWorkItem({ title: "leaf", status: "executing", source: "session", assignee: "tree-worker", parentId: mid.id });
    transitions.transition(top.id, "done", "operator", { human: true, cascade: true });
    expect(rows(leaf.id)).toEqual([expect.objectContaining({ parent_id: mid.id, to_status: "done", actor: "operator" })]);
    expect(rows(mid.id)).toEqual([expect.objectContaining({ parent_id: top.id, to_status: "done" })]);
  });

  it("an archive that cancels descendants records them", () => {
    const top = parent();
    const kid = child(top.id);
    archive.archiveWorkItem(top.id, "operator", { human: true, cascade: true });
    expect(rows(kid.id)).toEqual([expect.objectContaining({ parent_id: top.id, to_status: "cancelled" })]);
  });

  it("the reconciler's derived writes record too", () => {
    const kid = child(parent().id);
    transitions.transitionDerived(kid.id, "in_review", "reconciler");
    expect(rows(kid.id)).toEqual([expect.objectContaining({ actor: "reconciler", to_status: "in_review" })]);
  });

  it("a rollback drops the row with the move", () => {
    const kid = child(parent().id);
    expect(() => db.transaction(() => {
      transitions.transition(kid.id, "in_review", "board-walk");
      throw new Error("abort");
    })()).toThrow("abort");
    expect(rows(kid.id)).toEqual([]);
    expect(store.getWorkItem(kid.id)?.status).toBe("executing");
  });

  it("the same event is never recorded twice", () => {
    const kid = child(parent().id);
    const { event } = transitions.transition(kid.id, "in_review", "board-walk");
    settles.recordChildSettle(db, kid.parentId!, event!);
    expect(rows(kid.id)).toHaveLength(1);
  });

  it("pending rows are reported per parent with their oldest instant", () => {
    const top = parent();
    const first = child(top.id);
    const second = child(top.id);
    transitions.transition(first.id, "in_review", "board-walk");
    transitions.transition(second.id, "in_review", "board-walk");
    const mine = settles.parentsWithPendingSettles().filter((entry) => entry.parentId === top.id);
    expect(mine).toHaveLength(1);
    expect(settles.pendingChildSettles(top.id).map((row) => row.childId)).toEqual([first.id, second.id]);
    expect(settles.hasPendingChildSettles(top.id)).toBe(true);
  });
});
