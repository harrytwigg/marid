import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/** The store's half of a Todo's start date: every writer is normalised and
 *  checked before anything is allocated or stored, and only a first start is
 *  held by it. */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-start-date-store-"));

let store: typeof import("../store.js");
let startDate: typeof import("../start-date.js");

beforeAll(async () => {
  store = await import("../store.js");
  startDate = await import("../start-date.js");
  (await import("../../shared/db.js")).initDb();
});

const ordinal = (id: string): number => Number(id.split("-")[1]);

describe("start dates in the store", () => {
  it("normalises a start date from any writer, and refuses one that does not parse before storing anything", () => {
    const item = store.createWorkItem({ title: "plugin-made", startAt: "2026-11-02T09:00:00+01:00" });
    expect(store.getWorkItem(item.id)!.startAt).toBe("2026-11-02T08:00:00.000Z");
    const before = store.listWorkItems({}).length;
    expect(() => store.createWorkItem({ title: "unparseable", startAt: "next week" })).toThrow(/startAt must be an ISO 8601 timestamp/);
    expect(store.listWorkItems({})).toHaveLength(before);
  });

  it("does not burn a Todo number on a create refused for a start after its due date", () => {
    const first = store.createWorkItem({ title: "before" });
    expect(() => store.createWorkItem({ title: "backwards", startAt: "2026-12-02", dueAt: "2026-12-01" })).toThrow(/must not be after dueAt/);
    expect(ordinal(store.createWorkItem({ title: "after" }).id)).toBe(ordinal(first.id) + 1);
  });

  it("holds only a backlog Todo whose date is ahead", () => {
    const at = Date.parse("2026-10-06T12:00:00Z");
    const ahead = { id: "TST-1", startAt: "2026-10-07T00:00:00.000Z" };
    expect(startDate.startDateHold({ ...ahead, status: "backlog" }, at)).toMatch(/start date of 2026-10-07T00:00:00.000Z/);
    expect(startDate.startDateHold({ ...ahead, status: "executing" }, at)).toBeUndefined();
    expect(startDate.startDateHold({ ...ahead, status: "blocked" }, at)).toBeUndefined();
    expect(startDate.startDateHold({ ...ahead, status: "backlog" }, Date.parse(ahead.startAt))).toBeUndefined();
  });
});
