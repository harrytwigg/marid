import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-retired-statuses-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type EventLog = typeof import("../event-log.js");
type Retired = typeof import("../retired-statuses.js");
type Migrate = typeof import("../migrate.js");

let store: Store;
let events: EventLog;
let retired: Retired;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  events = await import("../event-log.js");
  retired = await import("../retired-statuses.js");
  migrate = await import("../migrate.js");
  db = (await import("../../shared/db.js")).initDb();
});

/** A row an older gateway wrote: the CHECK still admits both retired statuses. */
function legacyRow(status: "assigned" | "escalated", assignee: string | null) {
  const item = store.createWorkItem({ title: `legacy ${status}`, ...(assignee ? { assignee } : {}) });
  db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, item.id);
  return store.getWorkItem(item.id)!;
}

describe("the retired-status migration", () => {
  it("moves assigned to backlog and escalated to blocked, keeping the assignee, on boot", () => {
    const assigned = legacyRow("assigned", "platform-worker");
    const escalated = legacyRow("escalated", "platform-worker");
    const untouched = store.createWorkItem({ title: "already executing", status: "executing" });

    migrate.migrateWorkItemsSchema(db);

    const movedAssigned = store.getWorkItem(assigned.id)!;
    const movedEscalated = store.getWorkItem(escalated.id)!;
    expect([movedAssigned.status, movedAssigned.assignee]).toEqual(["backlog", "platform-worker"]);
    expect([movedEscalated.status, movedEscalated.assignee]).toEqual(["blocked", "platform-worker"]);
    expect(movedAssigned.version).toBe(assigned.version + 1);
    expect(movedEscalated.version).toBe(escalated.version + 1);
    expect(store.getWorkItem(untouched.id)!.version).toBe(untouched.version);
  });

  it("writes one migration event per row, and records a former escalation as a declared block", () => {
    const assigned = legacyRow("assigned", null);
    const escalated = legacyRow("escalated", "platform-worker");

    expect(retired.migrateRetiredStatuses(db)).toBe(2);

    const [fromAssigned] = events.listWorkItemEvents(assigned.id).filter((e) => e.actor === retired.RETIRED_STATUS_MIGRATION_ACTOR);
    const [fromEscalated] = events.listWorkItemEvents(escalated.id).filter((e) => e.actor === retired.RETIRED_STATUS_MIGRATION_ACTOR);
    expect(fromAssigned).toMatchObject({ kind: "status_change", fromStatus: "assigned", toStatus: "backlog" });
    expect(fromEscalated).toMatchObject({ kind: "status_change", fromStatus: "escalated", toStatus: "blocked" });
    expect(events.isBlockDeclared(escalated.id)).toBe(true);
  });

  it("writes nothing on a second boot", () => {
    legacyRow("escalated", null);
    retired.migrateRetiredStatuses(db);
    const before = db.prepare("SELECT COUNT(*) FROM work_item_events").pluck().get();

    expect(retired.migrateRetiredStatuses(db)).toBe(0);
    migrate.migrateWorkItemsSchema(db);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_events").pluck().get()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) FROM work_items WHERE status IN ('assigned', 'escalated')").pluck().get()).toBe(0);
  });
});
