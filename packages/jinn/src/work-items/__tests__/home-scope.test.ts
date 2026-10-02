import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-home-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Kept = typeof import("../kept.js");

let store: Store;
let kept: Kept;
let db: import("better-sqlite3").Database;

/* PLA-230 — Home is the union of what the operator pinned and what they created,
 * evaluated at query time. PLA-172's rule that creating never writes a pin row
 * still holds; this only widens what the Home query reads. */

/** The mixed fixture every case below reads: one root of each kind, plus a
 *  child of an operator root that the roots-only board must not show. */
const fixture = {} as {
  operatorUnpinned: string;
  operatorPinned: string;
  agentUnpinned: string;
  agentPinned: string;
  operatorChild: string;
};

beforeAll(async () => {
  store = await import("../store.js");
  kept = await import("../kept.js");
  db = (await import("../../shared/db.js")).initDb();

  const mk = (title: string, createdBy: string, extra: Record<string, unknown> = {}) =>
    store.createWorkItem({ title, createdBy, ...extra }).id;

  fixture.operatorUnpinned = mk("operator's own, never pinned", "operator", { source: "human", status: "backlog" });
  fixture.operatorPinned = mk("operator's own, also pinned", "operator", { source: "human", status: "in_review" });
  fixture.agentUnpinned = mk("an agent's, not pinned", "session:agent-1", { status: "executing" });
  fixture.agentPinned = mk("an agent's, pinned", "session:agent-2", { status: "backlog" });
  fixture.operatorChild = store.createWorkItem({
    title: "a sub-task of the operator's Todo",
    createdBy: "operator",
    parentId: fixture.operatorUnpinned,
  }).id;

  kept.setWorkItemKept(db, fixture.operatorPinned, true);
  kept.setWorkItemKept(db, fixture.agentPinned, true);
});

/** What the Home board asks the gateway for. */
const homePage = (extra: Record<string, unknown> = {}) =>
  store.queryWorkItems({ home: true, rootsOnly: true, limit: 100, ...extra });
const homeIds = (extra: Record<string, unknown> = {}) => homePage(extra).workItems.map((i) => i.id);

describe("the Home scope is the union of pinned and operator-created", () => {
  it("returns exactly that union, and each row once (criterion 1)", () => {
    const ids = homeIds();
    expect([...ids].sort()).toEqual(
      [fixture.operatorUnpinned, fixture.operatorPinned, fixture.agentPinned].sort(),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows an operator-created root with no pin row written (criterion 2)", () => {
    expect(kept.isWorkItemKept(db, fixture.operatorUnpinned)).toBe(false);
    expect(homeIds()).toContain(fixture.operatorUnpinned);
  });

  it("counts the union per status, not the intersection (criterion 1)", () => {
    const page = homePage();
    expect(page.total).toBe(3);
    expect(page.totals.backlog).toBe(2); // operatorUnpinned + agentPinned
    expect(page.totals.in_review).toBe(1); // operatorPinned
    expect(page.totals.executing).toBe(0); // agentUnpinned is not on Home
  });

  it("counts the whole union even when the page is capped (criterion 1)", () => {
    const page = homePage({ limit: 1 });
    expect(page.workItems.length).toBe(1);
    expect(page.total).toBe(3);
  });

  it("leaves Home a strict subset of Everything (criterion 5, PLA-172 guard)", () => {
    const everything = store.queryWorkItems({ rootsOnly: true, limit: 100 }).workItems.map((i) => i.id);
    const home = homeIds();
    for (const id of home) expect(everything).toContain(id);
    expect(everything).toContain(fixture.agentUnpinned);
    expect(home).not.toContain(fixture.agentUnpinned);
    expect(home.length).toBeLessThan(everything.length);
  });

  it("keeps sub-tasks off the roots-only board", () => {
    expect(homeIds()).not.toContain(fixture.operatorChild);
  });

  it("AND-composes with the board's other filters", () => {
    const ids = homeIds({ status: "backlog" });
    expect(ids).toContain(fixture.operatorUnpinned);
    expect(ids).toContain(fixture.agentPinned);
    expect(ids).not.toContain(fixture.operatorPinned);
  });
});

/* Criterion 8's server half. The Home board reaches SQL through a URL, and a
 * scope the gateway silently drops turns Home back into Everything. */
describe("the ?home=true query parameter", () => {
  it("reaches the filter, and is absent otherwise", async () => {
    const { readWorkItemQueryParams } = await import("../../gateway/work-item-query.js");
    const read = (search: string) => {
      const parsed = readWorkItemQueryParams(new URL(`http://x/api/work-items${search}`));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value.filter;
    };
    expect(read("?home=true&rootsOnly=true")).toMatchObject({ home: true, rootsOnly: true });
    expect(read("?kept=true").home).toBeUndefined();
    expect(read("?home=false").home).toBeUndefined();
  });
});

describe("unpinning", () => {
  it("removes an agent-created root from Home (criterion 3)", () => {
    const theirs = store.createWorkItem({ title: "an agent's, pinned then dropped", createdBy: "session:agent-3" }).id;
    expect(homeIds()).not.toContain(theirs);

    kept.setWorkItemKept(db, theirs, true);
    expect(homeIds()).toContain(theirs);

    kept.setWorkItemKept(db, theirs, false);
    expect(homeIds()).not.toContain(theirs);
  });

  it("leaves an operator-created root on Home (criterion 4)", () => {
    kept.setWorkItemKept(db, fixture.operatorPinned, false);
    expect(kept.isWorkItemKept(db, fixture.operatorPinned)).toBe(false);
    expect(homeIds()).toContain(fixture.operatorPinned);
  });
});
