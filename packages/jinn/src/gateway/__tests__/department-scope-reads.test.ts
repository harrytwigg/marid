import { beforeAll, describe, expect, it } from "vitest";
import { as, call, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import path from "node:path";
import type { Session } from "../../shared/types.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * FR-009 to FR-014 on the reads: lists and searches return only what is in D; ids
 * outside it are dropped silently; a Todo's relations and sessions outside D are
 * counted, not shown.
 */

let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let registry: Awaited<ReturnType<typeof startScopedHarness>>["registry"];
let mine: WorkItem;
let theirs: WorkItem;
let self: Session;
let peer: Session;
let coo: Session;
let eng: Session;
let scoped: ReturnType<typeof as>;

const ids = (rows: Array<{ id?: string; workItem?: { id: string } }>) => rows.map((row) => row.workItem?.id ?? row.id);
const sessionIds = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

beforeAll(async () => {
  ({ workItems, registry } = await startScopedHarness());
  mine = workItems.createWorkItem({ title: "reads-mine", department: "side-project", assignee: "side-dev" });
  theirs = workItems.createWorkItem({ title: "reads-theirs", department: "engineering" });
  self = await sessionOf("side-dev");
  peer = await sessionOf("side-qa");
  coo = await sessionOf(null);
  eng = await sessionOf("eng-dev");
  scoped = as(self.id);
  for (const session of [peer, coo, eng]) registry.insertMessage(session.id, "user", `reads-token from ${session.id}`);
  registry.updateSession(coo.id, { title: "reads-title coo" });
  registry.updateSession(peer.id, { title: "reads-title peer" });
});

describe("Todo lists and searches", () => {
  it("lists only D's Todos, by query and by ids", async () => {
    const byQuery = await scoped("GET", "/api/work-items?limit=100");
    expect(ids(byQuery.body.workItems)).toContain(mine.id);
    expect(ids(byQuery.body.workItems)).not.toContain(theirs.id);
    const mixed = await scoped("GET", `/api/work-items?ids=${mine.id},${theirs.id}`);
    expect(ids(mixed.body.workItems)).toEqual([mine.id]);
  });

  it("answers an empty page when every id is outside D, or another department is asked for", async () => {
    expect((await scoped("GET", `/api/work-items?ids=${theirs.id}`)).body).toEqual({ workItems: [] });
    expect(ids((await scoped("GET", "/api/work-items?department=engineering")).body.workItems)).toEqual([]);
    expect((await call("GET", `/api/work-items?ids=${theirs.id}`)).body.workItems).toHaveLength(1);
  });

  it("drops trees and search hits outside D", async () => {
    const trees = await scoped("GET", `/api/work-items/trees?ids=${mine.id},${theirs.id}`);
    expect(Object.keys(trees.body.trees)).toEqual([mine.id]);
    expect((await scoped("GET", `/api/work-items/trees?ids=${theirs.id}`)).body).toEqual({ trees: {} });
    const search = await scoped("GET", "/api/search/work-items?q=reads");
    expect(ids(search.body.workItems)).toEqual([mine.id]);
  });

  it("hides relations to Todos outside D and counts them", async () => {
    const inside = workItems.createWorkItem({ title: "reads-inside", department: "side-project" });
    await call("POST", `/api/work-items/${mine.id}/relations`, { dstId: theirs.id, kind: "relates" });
    await call("POST", `/api/work-items/${mine.id}/relations`, { dstId: inside.id, kind: "relates" });
    const read = await scoped("GET", `/api/work-items/${mine.id}`);
    expect(read.body.relations.map((relation: { other: { id: string } }) => relation.other.id)).toEqual([inside.id]);
    expect(read.body.hiddenRelations).toBe(1);
    const operator = await call("GET", `/api/work-items/${mine.id}`);
    expect(operator.body.relations).toHaveLength(2);
    expect(operator.body.hiddenRelations).toBeUndefined();
  });

  it("removes unbound sessions from a Todo's session tree, and counts them", async () => {
    workItems.linkSession(mine.id, peer.id, "operator", "review");
    workItems.linkSession(mine.id, coo.id, "operator", "execute");
    const tree = await scoped("GET", `/api/work-items/${mine.id}/sessions?tree=1`);
    expect(tree.status).toBe(200);
    expect(Object.keys(tree.body.directory)).toContain(peer.id);
    expect(Object.keys(tree.body.directory)).not.toContain(coo.id);
    expect(tree.body.hiddenCount).toBeGreaterThanOrEqual(1);
    const flat = await scoped("GET", `/api/work-items/${mine.id}/sessions`);
    expect(sessionIds(flat.body)).toEqual([peer.id]);
    const operator = await call("GET", `/api/work-items/${mine.id}/sessions?tree=1`);
    expect(Object.keys(operator.body.directory)).toContain(coo.id);
  });
});

describe("session lists and searches", () => {
  it("lists only sessions bound to D in every branch", async () => {
    const plain = await scoped("GET", "/api/sessions");
    expect(sessionIds(plain.body.sessions)).toEqual(expect.arrayContaining([self.id, peer.id]));
    expect(sessionIds(plain.body.sessions)).not.toContain(coo.id);
    expect(sessionIds(plain.body.sessions)).not.toContain(eng.id);
    expect(plain.body.counts).not.toHaveProperty("eng-dev");
    const all = await scoped("GET", "/api/sessions?limit=0");
    expect(sessionIds(all.body).sort()).toEqual(expect.arrayContaining([self.id, peer.id]));
    expect(sessionIds(all.body)).not.toContain(coo.id);
  });

  it("narrows ?q=, ?group= and ?pinned=1", async () => {
    const byText = await scoped("GET", "/api/sessions?q=reads-title");
    expect(sessionIds(byText.body)).toEqual([peer.id]);
    const grouped = await scoped("GET", `/api/sessions?group=${encodeURIComponent("eng-dev")}`);
    expect(sessionIds(grouped.body)).toEqual([]);
    registry.pinChat(`web:${coo.id}`);
    registry.pinChat(`web:${peer.id}`);
    const pinned = await scoped("GET", "/api/sessions?pinned=1");
    expect(sessionIds(pinned.body)).not.toContain(coo.id);
    expect(pinned.status).toBe(200);
  });

  it("narrows the session and message searches", async () => {
    const sessions = await scoped("GET", "/api/search/sessions?text=reads-title");
    expect(sessionIds(sessions.body.sessions)).toEqual([peer.id]);
    const messages = await scoped("GET", "/api/search/messages?q=reads-token");
    expect(messages.body.results.map((hit: { sessionId: string }) => hit.sessionId)).toEqual([peer.id]);
    expect((await call("GET", "/api/search/messages?q=reads-token")).body.results).toHaveLength(3);
  });
});

describe("org and departments", () => {
  it("shows only D's members, with their reporting lines narrowed to them", async () => {
    fs.writeFileSync(path.join(home, "org", "side-project", "side-dev.yaml"), "name: side-dev\ndisplayName: side-dev\ndepartment: side-project\nrank: employee\nengine: claude\nmodel: opus\nreportsTo: eng-dev\npersona: Works on side-project.\n");
    const { refreshOrg } = await import("../org-registry.js");
    refreshOrg();
    const org = await scoped("GET", "/api/org");
    expect(org.body.departments).toEqual(["side-project"]);
    expect(org.body.employees.map((employee: { name: string }) => employee.name).sort()).toEqual(["side-dev", "side-qa"]);
    expect(org.body.hierarchy.sorted.sort()).toEqual(["side-dev", "side-qa"]);
    expect((await call("GET", "/api/org")).body.employees.length).toBeGreaterThan(2);
  });

  // Finding: the member rows keep `reportsTo`, `parentName` and `chain` as the org scan
  // resolved them, so a manager outside D (here eng-dev) is named. The prompt roster strips
  // it (`departmentHierarchy`); the API does not. Flips red when the rows are narrowed too.
  it("does not name a manager outside D in the org rows", async () => {
    expect(JSON.stringify((await scoped("GET", "/api/org")).body)).not.toContain("eng-dev");
    expect(JSON.stringify((await scoped("GET", "/api/org/employees/side-dev")).body)).not.toContain("eng-dev");
  });

  it("lists only D, though other departments exist", async () => {
    const operator = await call("GET", "/api/departments");
    expect(operator.body.departments.map((department: { slug: string }) => department.slug)).toEqual(expect.arrayContaining(["side-project", "other-side"]));
    const own = await scoped("GET", "/api/departments");
    expect(own.body.departments.map((department: { slug: string }) => department.slug)).toEqual(["side-project"]);
  });
});
