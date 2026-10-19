import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-kept-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Kept = typeof import("../kept.js");

let store: Store;
let kept: Kept;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  kept = await import("../kept.js");
  db = (await import("../../shared/db.js")).initDb();
});

const mk = (createdBy: string, extra: Record<string, unknown> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, createdBy, ...extra });

/** Create it and put it on Home, which is now always two steps. */
const mkKept = (createdBy: string, extra: Record<string, unknown> = {}) => {
  const item = mk(createdBy, extra);
  kept.setWorkItemKept(db, item.id, true);
  return item;
};

/** What the Home board asks the gateway for. */
const homeIds = (extra: Record<string, unknown> = {}) =>
  store.queryWorkItems({ kept: true, rootsOnly: true, limit: 100, ...extra }).workItems.map((i) => i.id);

/* Home is what the operator pinned, and nothing else. `created_by`
 * does not decide it: any caller holding the operator credential mints Todos as
 * `operator`, so an agent relaying a request is indistinguishable from the
 * operator clicking New Todo. Keeping on create made Home a copy of Everything. */
describe("creating a Todo never puts it on Home", () => {
  it("leaves the operator's own Todo off Home", () => {
    db.exec("DELETE FROM work_item_kept");
    const mine = mk("operator");
    expect(db.prepare("SELECT COUNT(*) FROM work_item_kept").pluck().get()).toBe(0);
    expect(kept.isWorkItemKept(db, mine.id)).toBe(false);
    expect(homeIds()).not.toContain(mine.id);
  });

  it("leaves a Todo an agent mints in the operator's name off Home", () => {
    // `delegate_task` mints in the operator's name. That is the case that made
    // Home unusable: the operator never asked for the Todo by hand.
    const onBehalf = store.createWorkItem({ title: "raised for the operator", source: "delegation", createdBy: "operator" });
    expect(homeIds()).not.toContain(onBehalf.id);
  });

  it("leaves an agent's own Todo off Home", () => {
    const theirs = mk("session:agent-1");
    expect(kept.isWorkItemKept(db, theirs.id)).toBe(false);
    expect(homeIds()).not.toContain(theirs.id);
  });

  it("defaults a machine-sourced Todo to `system`, which is not kept either", () => {
    const cron = store.createWorkItem({ title: "nightly sweep", source: "cron", sourceRef: `cron:${Date.now()}` });
    expect(cron.createdBy).toBe("system");
    expect(kept.isWorkItemKept(db, cron.id)).toBe(false);
  });
});

/* Criterion 1: the whole point — a Todo the operator wants to follow. */
describe("keeping a Todo puts it on Home, and unkeeping takes it off", () => {
  it("round-trips", () => {
    const theirs = mk("session:agent-2", { department: "platform" });
    expect(homeIds()).not.toContain(theirs.id);

    expect(kept.setWorkItemKept(db, theirs.id, true)).toBe(true);
    expect(homeIds()).toContain(theirs.id);

    expect(kept.setWorkItemKept(db, theirs.id, false)).toBe(true);
    expect(homeIds()).not.toContain(theirs.id);
  });

  it("reports no change on a repeat, so a caller can stay silent about one", () => {
    const item = mk("session:agent-3");
    expect(kept.setWorkItemKept(db, item.id, true)).toBe(true);
    expect(kept.setWorkItemKept(db, item.id, true)).toBe(false);
    expect(kept.setWorkItemKept(db, item.id, false)).toBe(true);
    expect(kept.setWorkItemKept(db, item.id, false)).toBe(false);
  });

  it("does not move a Todo that was already on Home", () => {
    const mine = mkKept("operator");
    const first = db.prepare("SELECT kept_at FROM work_item_kept WHERE work_item_id = ?").pluck().get(mine.id);
    kept.setWorkItemKept(db, mine.id, true);
    expect(db.prepare("SELECT kept_at FROM work_item_kept WHERE work_item_id = ?").pluck().get(mine.id)).toBe(first);
  });

  it("lets the operator drop a Todo off Home without deleting it", () => {
    const mine = mkKept("operator");
    kept.setWorkItemKept(db, mine.id, false);
    expect(homeIds()).not.toContain(mine.id);
    expect(store.getWorkItem(mine.id)).toBeTruthy();
  });
});

describe("the kept filter composes with the board's other filters", () => {
  it("AND-composes with department and status", () => {
    const onPlatform = mkKept("operator", { department: "kept-platform", status: "backlog" });
    const elsewhere = mkKept("operator", { department: "kept-growth", status: "backlog" });
    const wrongStatus = mkKept("operator", { department: "kept-platform", status: "executing" });

    const ids = homeIds({ department: "kept-platform", status: "backlog" });
    expect(ids).toContain(onPlatform.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(wrongStatus.id);
  });

  it("counts the whole kept set, not the page", () => {
    const page = store.queryWorkItems({ kept: true, rootsOnly: true, limit: 1 });
    expect(page.workItems.length).toBe(1);
    expect(page.total).toBeGreaterThan(1);
  });

  it("shows sub-tasks only when the board is not asking for roots", () => {
    const parent = mkKept("operator");
    const child = store.createWorkItem({ title: "child", parentId: parent.id, createdBy: "operator" });
    kept.setWorkItemKept(db, child.id, true);
    expect(homeIds()).not.toContain(child.id);
    expect(store.queryWorkItems({ kept: true, limit: 100 }).workItems.map((i) => i.id)).toContain(child.id);
  });
});

describe("keptSet", () => {
  it("answers a whole page in one query, and is empty for none", () => {
    const mine = mkKept("operator");
    const theirs = mk("session:agent-4");
    expect(kept.keptSet(db, [mine.id, theirs.id])).toEqual(new Set([mine.id]));
    expect(kept.keptSet(db, [])).toEqual(new Set());
  });
});
