import { describe, it, expect, beforeAll, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-retired-opt-out-label-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type EventLog = typeof import("../event-log.js");
type Labels = typeof import("../labels.js");
type DispatchConfig = typeof import("../dispatch-config.js");
type Retired = typeof import("../retired-opt-out-label.js");
type AutoStart = typeof import("../auto-start.js");

let store: Store;
let events: EventLog;
let labels: Labels;
let dispatchConfig: DispatchConfig;
let retired: Retired;
let autoStart: AutoStart;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  events = await import("../event-log.js");
  labels = await import("../labels.js");
  dispatchConfig = await import("../dispatch-config.js");
  retired = await import("../retired-opt-out-label.js");
  autoStart = await import("../auto-start.js");
  db = (await import("../../shared/db.js")).initDb();
});

afterEach(() => {
  db.exec("DELETE FROM work_item_labels; DELETE FROM labels; DELETE FROM work_item_auto_start");
});

function labelled(title: string, names: string[], status?: "backlog" | "done") {
  for (const name of names) {
    if (!labels.listLabels().some((label) => label.name === name)) labels.createLabel({ name });
  }
  const item = store.createWorkItem({ title, ...(status ? { status } : {}) });
  labels.addWorkItemLabels(item.id, names, "operator");
  return store.getWorkItem(item.id)!;
}

const migrationEvents = (id: string) =>
  events.listWorkItemEvents(id).filter((event) => event.actor === retired.RETIRED_OPT_OUT_LABEL_ACTOR);

describe("the retired opt-out label migration", () => {
  it("sets autoStart: false on every Todo carrying the label, closed ones included, then deletes the label", () => {
    const open = labelled("held", ["no-auto-start"]);
    const closed = labelled("held and closed", ["no-auto-start"], "done");

    expect(retired.migrateRetiredOptOutLabel(db)).toBe(2);

    for (const item of [open, closed]) {
      expect(dispatchConfig.getTodoDispatchConfig(item.id)?.autoStart).toBe(false);
      expect(labels.getWorkItemLabels(item.id)).toEqual([]);
    }
    expect(labels.listLabels().map((label) => label.name)).not.toContain("no-auto-start");
  });

  it("overrides an autoStart: true the label used to beat, and keeps the Todo's other labels", () => {
    const item = labelled("switch on, label on", ["alpha", "no-auto-start", "zeta"]);
    autoStart.writeAutoStartRow(db, item.id, true, item.createdAt);

    retired.migrateRetiredOptOutLabel(db);

    expect(dispatchConfig.getTodoDispatchConfig(item.id)?.autoStart).toBe(false);
    expect(labels.getWorkItemLabels(item.id).map((label) => label.name)).toEqual(["alpha", "zeta"]);
  });

  it("records the change the way a live label write does: one label_changed event and a version bump", () => {
    const item = labelled("audited", ["alpha", "no-auto-start"]);

    retired.migrateRetiredOptOutLabel(db);

    expect(store.getWorkItem(item.id)!.version).toBe(item.version + 1);
    const [event] = migrationEvents(item.id);
    expect(event).toMatchObject({ kind: "label_changed", detail: { labels: ["alpha"], reason: "retired-opt-out-label", autoStart: false } });
    expect(migrationEvents(item.id)).toHaveLength(1);
  });

  it("writes nothing when no such label exists, and leaves unlabelled Todos alone", () => {
    const plain = labelled("plain", ["alpha"]);

    expect(retired.migrateRetiredOptOutLabel(db)).toBe(0);
    expect(retired.migrateRetiredOptOutLabel(db)).toBe(0);

    expect(store.getWorkItem(plain.id)!.version).toBe(plain.version);
    expect(dispatchConfig.getTodoDispatchConfig(plain.id)).toBeUndefined();
    expect(migrationEvents(plain.id)).toEqual([]);
  });

  it("carries a label re-created after an earlier run at the next one", () => {
    retired.migrateRetiredOptOutLabel(db);
    const late = labelled("labelled by an older gateway", ["no-auto-start"]);

    expect(retired.migrateRetiredOptOutLabel(db)).toBe(1);
    expect(dispatchConfig.getTodoDispatchConfig(late.id)?.autoStart).toBe(false);
  });
});
