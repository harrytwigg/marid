import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-sprints-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Sprints = typeof import("../sprints.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let sprints: Sprints;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  sprints = await import("../sprints.js");
  migrate = await import("../migrate.js");
  db = (await import("../../shared/db.js")).initDb();
});

function setStatus(id: string, status: string): void {
  db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, id);
}

/** Close whatever sprint is running so each case starts from a clean slate. */
function closeActive(): void {
  const active = sprints.listSprints().find((s) => s.status === "active");
  if (active) sprints.completeSprint(active.id, { carryTo: null }, "operator");
}

function ids(sprint: string): string[] {
  return store.listWorkItems({ sprint, rootsOnly: true }).map((item) => item.id).sort();
}

describe("creating and moving between sprints", () => {
  it("creates a named sprint and moves a Todo into it, then into another sprint", () => {
    const one = sprints.createSprint({ name: "Move Sprint 1", goal: "ship it", startsAt: "2026-10-05", endsAt: "2026-10-16" });
    const two = sprints.createSprint({ name: "Move Sprint 2" });
    expect(one).toMatchObject({ name: "Move Sprint 1", goal: "ship it", status: "planned", startsAt: "2026-10-05" });
    expect(one.id).toMatch(/^spr_[0-9a-f]{12}$/);

    const todo = store.createWorkItem({ title: "travels between sprints" });
    const before = store.getWorkItem(todo.id)!.version;

    const first = sprints.setWorkItemSprint(todo.id, one.id, "operator");
    expect(first).toMatchObject({ changed: true, sprint: { id: one.id } });
    expect(ids(one.id)).toEqual([todo.id]);
    expect(store.getWorkItem(todo.id)!.version).toBe(before + 1);

    // By name, case-insensitively, from one sprint straight into the next.
    const second = sprints.setWorkItemSprint(todo.id, "move sprint 2", "operator");
    expect(second).toMatchObject({ changed: true, sprint: { id: two.id } });
    expect(ids(one.id)).toEqual([]);
    expect(ids(two.id)).toEqual([todo.id]);
    expect(sprints.getWorkItemSprint(todo.id)).toEqual({ id: two.id, name: "Move Sprint 2", status: "planned" });

    const events = store.listWorkItemEvents(todo.id).filter((e) => e.kind === "sprint_changed");
    expect(events.map((e) => e.detail)).toEqual([
      { sprint: "Move Sprint 1", from: null },
      { sprint: "Move Sprint 2", from: "Move Sprint 1" },
    ]);

    // A repeat changes nothing and writes nothing.
    const version = store.getWorkItem(todo.id)!.version;
    expect(sprints.setWorkItemSprint(todo.id, two.id, "operator").changed).toBe(false);
    expect(store.getWorkItem(todo.id)!.version).toBe(version);

    // null takes it out of any sprint.
    expect(sprints.setWorkItemSprint(todo.id, null, "operator")).toMatchObject({ changed: true, sprint: null });
    expect(ids(two.id)).toEqual([]);
    expect(store.listWorkItems({ sprint: "none" }).some((item) => item.id === todo.id)).toBe(true);
  });

  it("refuses duplicate, reserved and empty names", () => {
    sprints.createSprint({ name: "Unique Sprint" });
    expect(() => sprints.createSprint({ name: "  unique   sprint " })).toThrow(/already exists/);
    expect(() => sprints.createSprint({ name: "Active" })).toThrow(/reserved/);
    expect(() => sprints.createSprint({ name: "none" })).toThrow(/reserved/);
    expect(() => sprints.createSprint({ name: "   " })).toThrow(/must not be empty/);
    expect(() => sprints.createSprint({ name: "Bad dates", startsAt: "2026-10-10", endsAt: "2026-10-01" })).toThrow(/on or before/);
    expect(() => sprints.createSprint({ name: "Bad day", startsAt: "2026-02-30" })).toThrow(/calendar date/);
    // Shape-valid but impossible: an Invalid Date, refused as a SprintError (a 400), never a RangeError.
    expect(() => sprints.createSprint({ name: "Bad month", startsAt: "2026-13-45" })).toThrow(sprints.SprintError);
    expect(() => sprints.createSprint({ name: "Bad month", endsAt: "2026-13-45" })).toThrow(/calendar date/);
    // A name shaped like an id would match two sprints in the filter.
    expect(() => sprints.createSprint({ name: "spr_0123456789ab" })).toThrow(/looks like a sprint id/);
  });

  it("keeps sub-tasks with their root: the filter follows the root and a sub-task cannot be moved alone", () => {
    const sprint = sprints.createSprint({ name: "Tree Sprint" });
    const root = store.createWorkItem({ title: "tree root" });
    const child = store.createWorkItem({ title: "tree child", parentId: root.id });
    sprints.setWorkItemSprint(root.id, sprint.id, "operator");

    expect(store.listWorkItems({ sprint: sprint.id }).map((i) => i.id).sort()).toEqual([root.id, child.id].sort());
    expect(sprints.getWorkItemSprint(child.id)?.id).toBe(sprint.id);
    expect(() => sprints.setWorkItemSprint(child.id, sprint.id, "operator")).toThrow(new RegExp(`set the sprint on ${root.id}`));
  });

  it("names the open sprints when a reference matches nothing", () => {
    const todo = store.createWorkItem({ title: "lost" });
    expect(() => sprints.setWorkItemSprint(todo.id, "No Such Sprint", "operator")).toThrow(/unknown sprint "No Such Sprint"; open sprints: .*Unique Sprint/);
  });
});

describe("the sprint lifecycle", () => {
  it("allows one active sprint at a time", () => {
    closeActive();
    const a = sprints.createSprint({ name: "Life A" });
    const b = sprints.createSprint({ name: "Life B" });
    expect(sprints.startSprint(a.id)).toMatchObject({ status: "active" });
    expect(sprints.startSprint(a.id).status).toBe("active"); // idempotent
    expect(() => sprints.startSprint(b.id)).toThrow(/"Life A" is still active; complete it before starting "Life B"/);
    // The index holds even against a direct write.
    expect(() => db.prepare("UPDATE sprints SET status = 'active' WHERE id = ?").run(b.id)).toThrow(/UNIQUE/);
    expect(store.listWorkItems({ sprint: "active" }).every((item) => sprints.getWorkItemSprint(item.id)?.id === a.id)).toBe(true);
  });

  it("completes the active sprint, carries unfinished Todos forward and starts the next", () => {
    closeActive();
    const current = sprints.createSprint({ name: "Carry From" });
    const next = sprints.createSprint({ name: "Carry To" });
    sprints.startSprint(current.id);
    const open = store.createWorkItem({ title: "still open" });
    const blocked = store.createWorkItem({ title: "blocked one" });
    const done = store.createWorkItem({ title: "finished" });
    const cancelled = store.createWorkItem({ title: "dropped" });
    for (const t of [open, blocked, done, cancelled]) sprints.setWorkItemSprint(t.id, current.id, "operator");
    setStatus(blocked.id, "blocked");
    setStatus(done.id, "done");
    setStatus(cancelled.id, "cancelled");

    const result = sprints.completeSprint(current.id, { carryTo: next.name, startNext: true }, "operator");
    expect(result.sprint).toMatchObject({ id: current.id, status: "closed" });
    expect(result.carried).toEqual([open.id, blocked.id].sort());
    expect(result.carriedTo).toMatchObject({ id: next.id, status: "active" });

    expect(ids(current.id)).toEqual([done.id, cancelled.id].sort());
    expect(ids(next.id)).toEqual([open.id, blocked.id].sort());
    const carriedEvent = store.listWorkItemEvents(open.id).filter((e) => e.kind === "sprint_changed").at(-1);
    expect(carriedEvent?.detail).toEqual({ sprint: "Carry To", from: "Carry From", reason: "carried" });

    const summary = sprints.listSprints();
    expect(summary[0]).toMatchObject({ id: next.id, status: "active", open: 2, total: 2 });
    expect(summary.find((s) => s.id === current.id)).toMatchObject({ status: "closed", open: 0, total: 2 });

    // History is frozen: nothing moves into a closed sprint, and it cannot be deleted or restarted.
    expect(() => sprints.setWorkItemSprint(open.id, current.id, "operator")).toThrow(/is closed/);
    expect(() => sprints.deleteSprint(current.id, "operator")).toThrow(/only a planned sprint/);
    expect(() => sprints.startSprint(current.id)).toThrow(/cannot be restarted/);
    expect(() => sprints.updateSprint(current.id, { name: "Renamed" })).toThrow(/only its goal/);
    expect(sprints.updateSprint(current.id, { goal: "retro notes" }).goal).toBe("retro notes");
  });

  it("can carry unfinished work out of any sprint, and refuses bad targets without closing anything", () => {
    closeActive();
    const running = sprints.createSprint({ name: "Drop Out" });
    sprints.startSprint(running.id);
    const todo = store.createWorkItem({ title: "back to backlog" });
    sprints.setWorkItemSprint(todo.id, running.id, "operator");

    const closed = sprints.listSprints().find((s) => s.status === "closed")!;
    expect(() => sprints.completeSprint(running.id, { carryTo: closed.id }, "operator")).toThrow(/only be carried to a planned sprint/);
    expect(() => sprints.completeSprint(running.id, { carryTo: running.id }, "operator")).toThrow(/into itself/);
    expect(() => sprints.completeSprint(running.id, { carryTo: null, startNext: true }, "operator")).toThrow(/startNext needs/);
    // The refusals rolled back: the sprint is still active and the Todo still in it.
    expect(sprints.getSprint(running.id)?.status).toBe("active");
    expect(ids(running.id)).toEqual([todo.id]);

    const result = sprints.completeSprint(running.id, { carryTo: null }, "operator");
    expect(result).toMatchObject({ carried: [todo.id], carriedTo: null });
    expect(sprints.getWorkItemSprint(todo.id)).toBeNull();
    expect(() => sprints.completeSprint(running.id, { carryTo: null }, "operator")).toThrow(/only the active sprint/);
  });

  it("keeps a closed sprint's finished Todos, and lets a reopened one leave", () => {
    closeActive();
    const old = sprints.createSprint({ name: "Record Keeper" });
    const next = sprints.createSprint({ name: "Record Next" });
    sprints.startSprint(old.id);
    const shipped = store.createWorkItem({ title: "shipped" });
    const dropped = store.createWorkItem({ title: "dropped" });
    const reopened = store.createWorkItem({ title: "reopened later" });
    for (const t of [shipped, dropped, reopened]) sprints.setWorkItemSprint(t.id, old.id, "operator");
    setStatus(shipped.id, "done");
    setStatus(dropped.id, "cancelled");
    setStatus(reopened.id, "done");
    sprints.completeSprint(old.id, { carryTo: null }, "operator");

    expect(() => sprints.setWorkItemSprint(shipped.id, next.id, "operator")).toThrow(/closed sprint "Record Keeper", which keeps it/);
    expect(() => sprints.setWorkItemSprint(dropped.id, null, "operator")).toThrow(/keeps it/);
    expect(sprints.listSprints().find((s) => s.id === old.id)?.total).toBe(3);

    // Reopened after the close: never carried, so it may still move on.
    setStatus(reopened.id, "backlog");
    expect(sprints.setWorkItemSprint(reopened.id, next.id, "operator").changed).toBe(true);
    expect(ids(old.id)).toEqual([shipped.id, dropped.id].sort());
  });

  it("moves to the running sprint by the word active, and out by none", () => {
    closeActive();
    const todo = store.createWorkItem({ title: "by keyword" });
    expect(() => sprints.setWorkItemSprint(todo.id, "active", "operator")).toThrow(/no sprint is active/);
    const running = sprints.createSprint({ name: "Keyword Sprint" });
    sprints.startSprint(running.id);
    expect(sprints.setWorkItemSprint(todo.id, "ACTIVE", "operator").sprint?.id).toBe(running.id);
    expect(sprints.setWorkItemSprint(todo.id, "none", "operator").sprint).toBeNull();
  });

  it("deletes a planned sprint, returning its Todos to no sprint", () => {
    const doomed = sprints.createSprint({ name: "Doomed" });
    const todo = store.createWorkItem({ title: "orphan" });
    sprints.setWorkItemSprint(todo.id, doomed.id, "operator");
    expect(sprints.deleteSprint(doomed.name, "operator")).toEqual([todo.id]);
    expect(sprints.getSprint(doomed.id)).toBeUndefined();
    expect(sprints.getWorkItemSprint(todo.id)).toBeNull();
  });
});

describe("schema", () => {
  it("passes the boot verifier with sprint data present", () => {
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
  });

  it("heals a registry from before sprints shipped by creating both tables at boot", () => {
    const file = path.join(tmp, "pre-sprints.db");
    db.exec(`VACUUM INTO '${file}'`); // a consistent copy, WAL included
    const old = new Database(file);
    old.exec("DROP TABLE work_item_sprints; DROP TABLE sprints;");
    old.close();
    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");
    const healed = new Database(file);
    try {
      migrate.migrateWorkItemsSchema(healed, "current");
      const tables = healed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sprints','work_item_sprints')").pluck().all();
      expect(tables.sort()).toEqual(["sprints", "work_item_sprints"]);
      expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    } finally {
      healed.close();
    }
  });
});
