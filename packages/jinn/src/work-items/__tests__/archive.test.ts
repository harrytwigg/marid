import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-archive-"));
process.env.JINN_HOME = home;

let store: typeof import("../store.js");
let archive: typeof import("../archive.js");
let db: Database;

beforeAll(async () => {
  store = await import("../store.js");
  archive = await import("../archive.js");
  db = (await import("../../shared/db.js")).initDb();
});

function cancellations(id: string) {
  return store.listWorkItemEvents(id).filter((event) => event.toStatus === "cancelled");
}

describe("archiveWorkItem", () => {
  it("cancels an open Todo and records the archive action with its note", () => {
    const item = store.createWorkItem({ title: "to archive", status: "executing" });
    const archived = archive.archiveWorkItem(item.id, "operator", { human: true, note: "superseded" });
    expect(archived.status).toBe("cancelled");
    expect(store.getWorkItem(item.id)?.status).toBe("cancelled");
    const [event] = cancellations(item.id);
    expect(event.actor).toBe("operator");
    expect(event.detail).toMatchObject({ action: "archive", note: "superseded" });
  });

  it("is a no-op on a Todo that is already cancelled", () => {
    const item = store.createWorkItem({ title: "already gone" });
    const first = archive.archiveWorkItem(item.id, "operator", { human: true });
    const again = archive.archiveWorkItem(item.id, "operator", { human: true });
    expect(again.version).toBe(first.version);
    expect(cancellations(item.id)).toHaveLength(1);
  });

  it("throws for a Todo that does not exist", () => {
    expect(() => archive.archiveWorkItem("TST-99999", "operator", { human: true })).toThrow(/not found/);
  });

  it("with cascade and human authority cancels open descendants deepest first", () => {
    const parent = store.createWorkItem({ title: "cascade parent" });
    const mid = store.createWorkItem({ title: "cascade mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "cascade leaf", parentId: mid.id });

    archive.archiveWorkItem(parent.id, "operator", { human: true, cascade: true, note: "wrapping up" });

    for (const id of [parent.id, mid.id, leaf.id]) expect(store.getWorkItem(id)?.status).toBe("cancelled");
    const stamp = (id: string) => store.listWorkItemEvents(id).find((event) => event.toStatus === "cancelled")!;
    // Insertion order, not timestamps: three cancellations can share a millisecond.
    const written = db
      .prepare("SELECT work_item_id FROM work_item_events WHERE to_status = 'cancelled' AND work_item_id IN (?, ?, ?) ORDER BY rowid")
      .pluck()
      .all(parent.id, mid.id, leaf.id);
    expect(written).toEqual([leaf.id, mid.id, parent.id]);
    expect(stamp(leaf.id).detail).toMatchObject({ cascadeFrom: parent.id, note: "wrapping up" });
    expect(stamp(parent.id).detail).toMatchObject({ action: "archive" });
  });

  it("with cascade but no human authority does not cascade, and the open child blocks the cancel", () => {
    const parent = store.createWorkItem({ title: "agent parent" });
    const child = store.createWorkItem({ title: "agent child", parentId: parent.id });
    expect(() => archive.archiveWorkItem(parent.id, "agent", { cascade: true })).toThrow();
    expect(store.getWorkItem(child.id)?.status).toBe("backlog");
    expect(store.getWorkItem(parent.id)?.status).toBe("backlog");
  });
});
