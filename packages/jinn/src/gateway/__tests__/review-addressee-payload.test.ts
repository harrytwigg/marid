import { beforeAll, describe, expect, it } from "vitest";
import { call, sessionOf, startParentReviewHarness, statusPost, treeInReview } from "./review-addressee-harness.js";

/**
 * Who a review is addressed to, as the Todo payloads, the attention lane and the
 * recovery sweep report it: an employee-addressed review is Manager attention and
 * reads as such; every other Todo reaches the operator's desk as before.
 */

let workItems: Awaited<ReturnType<typeof startParentReviewHarness>>["workItems"];
let sweepTodoRecovery: typeof import("../../work-items/recovery-controller.js").sweepTodoRecovery;
let getWorkItemRecovery: typeof import("../../work-items/recovery-rows.js").getWorkItemRecovery;
let assignWorkItem: typeof import("../../work-items/assignment.js").assignWorkItem;

beforeAll(async () => {
  ({ workItems } = await startParentReviewHarness());
  ({ sweepTodoRecovery } = await import("../../work-items/recovery-controller.js"));
  ({ getWorkItemRecovery } = await import("../../work-items/recovery-rows.js"));
  ({ assignWorkItem } = await import("../../work-items/assignment.js"));
});

const sweep = () => sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ unavailable: "test" }) as never });
const detail = async (id: string) => (await call("GET", `/api/work-items/${id}`)).body;
const listed = async (id: string) =>
  (await call("GET", "/api/work-items?status=in_review&limit=200")).body.workItems.find((row: { id: string }) => row.id === id);

describe("the Todo payloads", () => {
  it("carry the addressee on the compact row, the full detail and the board enrichment", async () => {
    const { child, parent } = treeInReview(workItems, "Payload");
    const operatorChild = treeInReview(workItems, "Payload operator", { parentOwner: "@operator" }).child;
    const root = workItems.createWorkItem({ title: "Payload root", status: "in_review", assignee: "owner-dev" });

    expect((await listed(child.id)).reviewAddressee).toEqual({ kind: "employee", employee: "owner-dev" });
    expect((await listed(operatorChild.id)).reviewAddressee).toEqual({ kind: "operator" });
    expect((await listed(root.id)).reviewAddressee).toEqual({ kind: "operator" });
    expect((await detail(child.id)).reviewAddressee).toEqual({ kind: "employee", employee: "owner-dev" });
    expect((await detail(parent.id)).reviewAddressee).toEqual({ kind: "operator" });
    const open = (await call("GET", `/api/work-items?ids=${child.id},${root.id}`)).body.workItems;
    expect(open.map((row: { reviewAddressee: unknown }) => row.reviewAddressee)).toEqual([
      { kind: "employee", employee: "owner-dev" },
      { kind: "operator" },
    ]);
  });
});

describe("the tree routes", () => {
  it("carry the addressee on every node, from the node's parent in the tree", async () => {
    const { parent, child } = treeInReview(workItems, "Tree");
    const grandchild = workItems.createWorkItem({ title: "Tree grandchild", status: "in_review", parentId: child.id });
    const operatorTree = treeInReview(workItems, "Tree operator", { parentOwner: "@operator" });

    const tree = (await call("GET", `/api/work-items/${parent.id}/tree`)).body.tree;
    expect(tree.root.reviewAddressee).toEqual({ kind: "operator" });
    expect(tree.root.children[0].reviewAddressee).toEqual({ kind: "employee", employee: "owner-dev" });
    // The grandchild's parent is the child, which is assigned to child-dev, an employee in the org.
    expect(tree.root.children[0].children[0]).toMatchObject({ id: grandchild.id, reviewAddressee: { kind: "employee", employee: "child-dev" } });

    const batch = (await call("GET", `/api/work-items/trees?ids=${parent.id},${operatorTree.parent.id}`)).body.trees;
    expect(batch[parent.id].root.children[0].reviewAddressee).toEqual({ kind: "employee", employee: "owner-dev" });
    expect(batch[operatorTree.parent.id].root.children[0].reviewAddressee).toEqual({ kind: "operator" });
  });
});

describe("the operator's attention feed", () => {
  it("leaves out an employee-addressed review, and the stalled parent is in it", async () => {
    const { transition } = await import("../../work-items/transitions.js");
    const parent = workItems.createWorkItem({ title: "Stalled parent", status: "backlog", assignee: "owner-dev" });
    transition(parent.id, "executing", "operator", { human: true, manual: true });
    const child = workItems.createWorkItem({ title: "Waiting child", status: "executing", parentId: parent.id, assignee: "child-dev" });
    transition(child.id, "in_review", "operator", { detail: { note: "ready" } });
    const operatorChild = treeInReview(workItems, "Feed operator", { parentOwner: "@operator" }).child;
    const feed = async () =>
      (await call("GET", "/api/work-items?needsAttentionFor=me&limit=200")).body.workItems.map((row: { id: string }) => row.id);

    // The parent owner was woken and has not acted: the review is the owner's, not an inbox row.
    sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ unavailable: "test" }) as never });
    expect(getWorkItemRecovery(child.id)).toMatchObject({ lane: "manager" });
    expect(await feed()).not.toContain(child.id);

    // Four hours on with no producer running, the parent itself is flagged and surfaces.
    sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ unavailable: "test" }) as never, now: () => new Date(Date.now() + 5 * 60 * 60_000) });
    expect(getWorkItemRecovery(parent.id)).toMatchObject({ lane: "manager" });
    const surfaced = await feed();
    expect(surfaced).toContain(parent.id);
    expect(surfaced).not.toContain(child.id);
    expect(operatorChild.status).toBe("in_review");
  });
});

describe("the attention lane", () => {
  it("is manager for an employee-addressed review, and unchanged for every other Todo", async () => {
    const { child, parent } = treeInReview(workItems, "Lane");
    const operatorChild = treeInReview(workItems, "Lane operator", { parentOwner: "@operator" }).child;
    const root = workItems.createWorkItem({ title: "Lane root", status: "in_review", assignee: "owner-dev" });

    expect((await listed(child.id)).attentionLane).toBe("manager");
    expect((await detail(child.id)).attentionLane).toBe("manager");
    expect((await listed(operatorChild.id)).attentionLane).toBeNull();
    expect((await listed(root.id)).attentionLane).toBeNull();
    expect((await detail(parent.id)).attentionLane).toBeNull();
  });

  it("follows the parent: reassigned to the operator, the review is the operator's again", async () => {
    const { child, parent } = treeInReview(workItems, "Lane reassigned");
    sweep();
    expect((await listed(child.id)).attentionLane).toBe("manager");

    assignWorkItem(parent.id, "@operator", null, "operator");
    // Before the next sweep: the stale row must not keep the child on the manager lane.
    expect((await listed(child.id)).attentionLane).toBe("operator");
    sweep();
    expect(getWorkItemRecovery(child.id)).toMatchObject({ lane: "operator" });
    expect((await listed(child.id)).attentionLane).toBe("operator");
  });

  it("is not manager once the child has left review", async () => {
    const { child } = treeInReview(workItems, "Lane left review");
    sweep();
    expect(getWorkItemRecovery(child.id)?.lane).toBe("manager");

    expect((await statusPost((await sessionOf("owner-dev")).id, child.id, { status: "executing", note: "more work" })).status).toBe(200);

    expect(getWorkItemRecovery(child.id)).toBeUndefined();
    expect((await detail(child.id)).attentionLane).toBeNull();
  });
});

describe("the recovery classifier", () => {
  it("gives an employee-addressed review lane manager with a reason naming the addressee", () => {
    const { child } = treeInReview(workItems, "Recovery");
    sweep();
    const row = getWorkItemRecovery(child.id)!;
    expect(row).toMatchObject({ lane: "manager", class: "operator" });
    expect(row.reason).toContain("owner-dev");
  });

  it("leaves a root and a child of an operator-owned parent on the operator lane", () => {
    const root = workItems.createWorkItem({ title: "Recovery root", status: "in_review", assignee: "owner-dev" });
    const { child } = treeInReview(workItems, "Recovery operator parent", { parentOwner: "@operator" });
    sweep();
    for (const id of [root.id, child.id]) {
      expect(getWorkItemRecovery(id)).toMatchObject({ lane: "operator", reason: "no safe automatic recovery is known" });
    }
  });
});

describe("board hooks", () => {
  it("put the addressee in the payload, and a reviewAddressee matcher tells the desks apart", async () => {
    const { buildBasePayload } = await import("../../board-hooks/payload.js");
    const { matchesHook } = await import("../../board-hooks/matcher.js");
    const { listWorkItemEvents } = await import("../../work-items/event-log.js");
    const { transition } = await import("../../work-items/transitions.js");
    const handedIn = (parentOwner: string) => {
      const parent = workItems.createWorkItem({ title: "Hook parent", status: "executing", assignee: parentOwner });
      const child = workItems.createWorkItem({ title: "Hook child", status: "executing", parentId: parent.id, assignee: "child-dev" });
      transition(child.id, "in_review", "operator", { detail: { note: "ready" } });
      const event = listWorkItemEvents(child.id).filter((row) => row.kind === "status_change" && row.toStatus === "in_review").at(-1)!;
      return buildBasePayload(event, "todo.status_changed")!;
    };
    const parentOwned = handedIn("owner-dev");
    const operatorOwned = handedIn("@operator");

    expect(parentOwned.todo.reviewAddressee).toEqual({ kind: "employee", employee: "owner-dev" });
    expect(operatorOwned.todo.reviewAddressee).toEqual({ kind: "operator" });
    const forOperator = { match: { to: "in_review", reviewAddressee: "operator" } };
    const forEmployee = { match: { reviewAddressee: "employee" } };
    const open = { match: { to: "in_review" } };
    const fires = (hook: { match: Record<string, string> }, payload: typeof parentOwned) => matchesHook(hook, payload, []);
    expect([fires(forOperator, parentOwned), fires(forOperator, operatorOwned)]).toEqual([false, true]);
    expect([fires(forEmployee, parentOwned), fires(forEmployee, operatorOwned)]).toEqual([true, false]);
    expect([fires(open, parentOwned), fires(open, operatorOwned)]).toEqual([true, true]);
  });
});
