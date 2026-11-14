import { beforeAll, describe, expect, it } from "vitest";
import { startParentReviewHarness } from "../../gateway/__tests__/review-addressee-harness.js";

let workItems: Awaited<ReturnType<typeof startParentReviewHarness>>["workItems"];
let reparentWorkItem: typeof import("../reparent.js").reparentWorkItem;
let ReparentError: typeof import("../reparent.js").ReparentError;
let reviewAddressee: typeof import("../review-addressee.js").reviewAddressee;
let transition: typeof import("../transitions.js").transition;
let sprints: typeof import("../sprints.js");

beforeAll(async () => {
  ({ workItems } = await startParentReviewHarness());
  ({ reparentWorkItem, ReparentError } = await import("../reparent.js"));
  ({ reviewAddressee } = await import("../review-addressee.js"));
  ({ transition } = await import("../transitions.js"));
  sprints = await import("../sprints.js");
});

const get = (id: string) => workItems.getWorkItem(id)!;
const make = (title: string, parentId?: string, extra: Record<string, unknown> = {}) => workItems.createWorkItem({ title, parentId, ...extra });
const events = (id: string) => workItems.listWorkItemEvents(id);

describe("reparentWorkItem", () => {
  it("detaches a sub-task to a root, taking its own children with it", () => {
    const root = make("root");
    const child = make("child", root.id);
    const grandchild = make("grandchild", child.id);
    const sibling = make("sibling", root.id);

    const result = reparentWorkItem(child.id, null, { actor: "operator" });

    expect(result.changed).toBe(true);
    expect(get(child.id)).toMatchObject({ parentId: null, rootId: child.id, depth: 0 });
    expect(get(grandchild.id)).toMatchObject({ parentId: child.id, rootId: child.id, depth: 1 });
    expect(get(sibling.id)).toMatchObject({ parentId: root.id, rootId: root.id, depth: 1 });
    expect(result.moved.sort()).toEqual([child.id, grandchild.id].sort());
  });

  it("makes a root a sub-task, recomputing root and depth for its whole subtree", () => {
    const target = make("target");
    const mid = make("mid", target.id);
    const root = make("other root");
    const child = make("other child", root.id);
    const grandchild = make("other grandchild", child.id);

    reparentWorkItem(root.id, target.id, { actor: "operator" });

    expect(get(root.id)).toMatchObject({ parentId: target.id, rootId: target.id, depth: 1 });
    expect(get(child.id)).toMatchObject({ rootId: target.id, depth: 2 });
    expect(get(grandchild.id)).toMatchObject({ rootId: target.id, depth: 3 });
    expect(get(mid.id)).toMatchObject({ rootId: target.id, depth: 1 });
  });

  it("moves a sub-task from one parent to another", () => {
    const a = make("a");
    const b = make("b");
    const child = make("child", a.id);
    const grandchild = make("grandchild", child.id);

    reparentWorkItem(child.id, b.id);

    expect(get(child.id)).toMatchObject({ parentId: b.id, rootId: b.id, depth: 1 });
    expect(get(grandchild.id)).toMatchObject({ rootId: b.id, depth: 2 });
    expect(workItems.listWorkItems({ rootId: a.id }).map((i) => i.id)).toEqual([a.id]);
  });

  it("refuses a cycle: itself, or one of its own descendants", () => {
    const root = make("root");
    const child = make("child", root.id);
    const grandchild = make("grandchild", child.id);

    expect(() => reparentWorkItem(root.id, root.id)).toThrow(/own parent/);
    expect(() => reparentWorkItem(root.id, grandchild.id)).toThrow(/already beneath/);
    expect(() => reparentWorkItem(child.id, grandchild.id)).toThrow(/already beneath/);
    expect(get(root.id)).toMatchObject({ parentId: null, depth: 0 });
    expect(get(child.id)).toMatchObject({ parentId: root.id, depth: 1 });
  });

  it("refuses a subtree that would pass the depth cap, writing nothing", () => {
    const d0 = make("d0");
    const d1 = make("d1", d0.id);
    const d2 = make("d2", d1.id);
    const root = make("root");
    const child = make("child", root.id);
    const grandchild = make("grandchild", child.id);

    expect(() => reparentWorkItem(root.id, d2.id)).toThrow(/depth 5|capped at depth 3/);
    expect(() => reparentWorkItem(child.id, d2.id)).toThrow(/capped at depth 3/);
    expect(get(child.id)).toMatchObject({ parentId: root.id, depth: 1 });
    expect(get(grandchild.id)).toMatchObject({ rootId: root.id, depth: 2 });
    // One level shallower fits: a leaf under d2 lands at depth 3.
    reparentWorkItem(grandchild.id, d2.id);
    expect(get(grandchild.id)).toMatchObject({ rootId: d0.id, depth: 3 });
  });

  it("refuses a closed parent, and an unknown parent or Todo", () => {
    const closed = make("closed");
    transition(closed.id, "done", "operator", { human: true });
    const loose = make("loose");
    expect(() => reparentWorkItem(loose.id, closed.id)).toThrow(/closed/);
    expect(() => reparentWorkItem(loose.id, "ZZZ-999")).toThrow(/not found/);
    expect(() => reparentWorkItem("ZZZ-999", null)).toThrow(ReparentError);
  });

  it("is a no-op, writing nothing, when the parent is already the one named", () => {
    const root = make("root");
    const child = make("child", root.id);
    const before = get(child.id).version;
    const again = reparentWorkItem(child.id, root.id);
    const alreadyRoot = reparentWorkItem(root.id, null);
    expect(again.changed).toBe(false);
    expect(alreadyRoot.changed).toBe(false);
    expect(get(child.id).version).toBe(before);
  });

  it("records the change on the Todo, its moved sub-tasks and both parents", () => {
    const oldParent = make("old parent");
    const newParent = make("new parent");
    const child = make("child", oldParent.id);
    const grandchild = make("grandchild", child.id);

    reparentWorkItem(child.id, newParent.id, { actor: "operator", origin: "talk" });

    const own = events(child.id).find((e) => (e.detail as { reparented?: unknown } | null)?.reparented);
    expect(own?.actor).toBe("operator");
    expect(own?.detail).toMatchObject({ reparented: { from: oldParent.id, to: newParent.id, rootFrom: oldParent.id, rootTo: newParent.id, depth: 1 }, movedWith: [grandchild.id] });
    expect(events(grandchild.id).some((e) => (e.detail as { reparented?: { with?: string } } | null)?.reparented?.with === child.id)).toBe(true);
    for (const parent of [oldParent, newParent]) {
      expect(events(parent.id).some((e) => (e.detail as { childReparented?: { child?: string } } | null)?.childReparented?.child === child.id)).toBe(true);
      expect(get(parent.id).version).toBeGreaterThan(parent.version);
    }
  });

  it("moves a child's review to the operator when it is detached, and to the new owner when it becomes a sub-task", () => {
    const parent = make("owned parent", undefined, { status: "executing", assignee: "owner-dev" });
    const child = make("reviewed child", parent.id, { status: "in_review", assignee: "child-dev" });
    expect(reviewAddressee(get(child.id))).toEqual({ kind: "employee", employee: "owner-dev" });

    reparentWorkItem(child.id, null);
    expect(reviewAddressee(get(child.id))).toEqual({ kind: "operator" });

    const other = make("other owned parent", undefined, { status: "executing", assignee: "third-dev" });
    const working = make("working child", undefined, { status: "executing", assignee: "child-dev" });
    reparentWorkItem(working.id, other.id);
    transition(working.id, "in_review", "child-dev", { detail: { note: "ready" } });
    expect(reviewAddressee(get(working.id))).toEqual({ kind: "employee", employee: "third-dev" });
  });

  it("refuses to hand a Todo already in review to an owner who has not been told", () => {
    const parent = make("worked parent", undefined, { status: "executing", assignee: "owner-dev" });
    const waiting = make("waiting for review", undefined, { status: "in_review", assignee: "child-dev" });
    expect(() => reparentWorkItem(waiting.id, parent.id)).toThrow(/in review/);
    // A parent that is not being worked addresses the operator, so nothing changes for the child.
    const idle = make("idle parent", undefined, { status: "backlog", assignee: "owner-dev" });
    reparentWorkItem(waiting.id, idle.id);
    expect(reviewAddressee(get(waiting.id))).toEqual({ kind: "operator" });
  });

  it("refuses to make a root that sits in a sprint a sub-task, and lets it go once the sprint is cleared", () => {
    const sprint = sprints.createSprint({ name: "reparent sprint" });
    const root = make("sprinting root");
    const home = make("home");
    sprints.setWorkItemSprint(root.id, sprint.id, "operator");
    expect(() => reparentWorkItem(root.id, home.id)).toThrow(/sprint/);
    sprints.setWorkItemSprint(root.id, null, "operator");
    reparentWorkItem(root.id, home.id);
    expect(get(root.id).rootId).toBe(home.id);
  });

  it("keeps a closed sub-task's history when it is detached", () => {
    const root = make("root");
    const child = make("child", root.id);
    transition(child.id, "done", "operator", { human: true });
    reparentWorkItem(child.id, null);
    expect(get(child.id)).toMatchObject({ status: "done", parentId: null, rootId: child.id });
  });

  it("keeps a closed sprint's finished Todos in it, and lets nothing new join it", () => {
    const sprint = sprints.createSprint({ name: "closing sprint" });
    const root = make("record root");
    const kept = make("finished child", root.id);
    sprints.setWorkItemSprint(root.id, sprint.id, "operator");
    sprints.startSprint(sprint.id);
    transition(kept.id, "done", "operator", { human: true });
    transition(root.id, "done", "operator", { human: true });
    sprints.completeSprint(sprint.id, { carryTo: null }, "operator");

    expect(() => reparentWorkItem(kept.id, null)).toThrow(/keeps it as its record/);
    expect(sprints.getWorkItemSprint(kept.id)?.name).toBe("closing sprint");

    // Reopened after the sprint closed, the root was never carried: work under it
    // may leave (the event says where it went), but nothing new may join it.
    transition(root.id, "backlog", "operator", { human: true });
    const open = make("reopened child", root.id);
    const loose = make("late arrival");
    expect(() => reparentWorkItem(loose.id, root.id)).toThrow(/is closed/);
    reparentWorkItem(open.id, null);
    expect(sprints.getWorkItemSprint(open.id)).toBeNull();
    expect(events(open.id).find((e) => (e.detail as { reparented?: unknown } | null)?.reparented)?.detail).toMatchObject({ sprint: { from: "closing sprint", to: null } });
  });

  it("lets open work follow its new root between open sprints, recording both", () => {
    const a = sprints.createSprint({ name: "open sprint a" });
    const b = sprints.createSprint({ name: "open sprint b" });
    const rootA = make("root a");
    const rootB = make("root b");
    const child = make("child of a", rootA.id);
    sprints.setWorkItemSprint(rootA.id, a.id, "operator");
    sprints.setWorkItemSprint(rootB.id, b.id, "operator");
    reparentWorkItem(child.id, rootB.id);
    expect(sprints.getWorkItemSprint(child.id)?.name).toBe("open sprint b");
    expect(events(child.id).find((e) => (e.detail as { reparented?: unknown } | null)?.reparented)?.detail).toMatchObject({ sprint: { from: "open sprint a", to: "open sprint b" } });
  });

  it("refuses to move a Todo into an archived department's scope, as create does", async () => {
    const { setDepartmentArchived } = await import("../department-archive.js");
    const { initDb } = await import("../../shared/db.js");
    const root = make("archived root", undefined, { department: "retired-dept" });
    const loose = make("loose todo");
    setDepartmentArchived(initDb(), "retired-dept", true, "JIN");
    expect(() => make("new child", root.id)).toThrow(/archived/);
    expect(() => reparentWorkItem(loose.id, root.id)).toThrow(/archived/);
    expect(get(loose.id).parentId).toBeNull();
  });
});
