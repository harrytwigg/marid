import { beforeAll, describe, expect, it } from "vitest";
import { call, sessionOf, startParentReviewHarness, statusPost, treeInReview } from "./review-addressee-harness.js";

/**
 * The parent-owner lane, through the real `handleApiRequest`: the employee that
 * owns a child Todo's parent accepts it (`done`, with a reason) or sends it back
 * (`executing`, a review bounce) while the child is in review, and nothing else.
 */

let workItems: Awaited<ReturnType<typeof startParentReviewHarness>>["workItems"];
let listComments: typeof import("../../work-items/comments.js").listComments;
let listWorkItemEvents: typeof import("../../work-items/event-log.js").listWorkItemEvents;
let transition: typeof import("../../work-items/transitions.js").transition;
let assignWorkItem: typeof import("../../work-items/assignment.js").assignWorkItem;

beforeAll(async () => {
  ({ workItems } = await startParentReviewHarness());
  ({ listComments } = await import("../../work-items/comments.js"));
  ({ listWorkItemEvents } = await import("../../work-items/event-log.js"));
  ({ transition } = await import("../../work-items/transitions.js"));
  ({ assignWorkItem } = await import("../../work-items/assignment.js"));
});

const statusOf = (id: string) => workItems.getWorkItem(id)?.status;
const lastMove = (id: string) => listWorkItemEvents(id).filter((event) => event.toStatus !== null).at(-1)!;
const accept = { status: "done", note: "Integrated into the parent branch" };
const sendBack = { status: "executing", note: "Needs the migration test" };

describe("the parent's owner accepting a child in review", () => {
  it("closes it as itself: comment posted, actor and detail on the event", async () => {
    const { child } = treeInReview(workItems, "Accept");
    const owner = await sessionOf("owner-dev");

    const res = await statusPost(owner.id, child.id, accept);

    expect([res.status, res.body.workItem.status]).toEqual([200, "done"]);
    const comments = listComments(child.id).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body: "Accepted as done by owner-dev, who owns the parent Todo. Reason: Integrated into the parent branch",
      author: "owner-dev",
      authorKind: "employee",
      sessionId: owner.id,
    });
    const event = lastMove(child.id);
    expect(event.actor).toBe(`session:${owner.id}`);
    expect(event.detail).toMatchObject({ parentOwner: true, note: accept.note, actorEmployee: "owner-dev" });
    expect(event.detail).not.toHaveProperty("closeTodos");
    expect(event.detail).not.toHaveProperty("operatorLane");
  });

  it("needs the reason, and leaves the child in review without it", async () => {
    const { child } = treeInReview(workItems, "Accept without a note");
    const owner = await sessionOf("owner-dev");
    for (const body of [{ status: "done" }, { status: "done", note: "  " }]) {
      const res = await statusPost(owner.id, child.id, body);
      expect([res.status, res.body.error]).toEqual([400, expect.stringMatching(/needs the reason in note/)]);
    }
    expect(statusOf(child.id)).toBe("in_review");
    expect(listComments(child.id).total).toBe(0);
  });

  it("is held by the open-children gate", async () => {
    const { child } = treeInReview(workItems, "Child with open work");
    workItems.createWorkItem({ title: "Grandchild", parentId: child.id, status: "executing" });
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/still has open children/)]);
    expect(statusOf(child.id)).toBe("in_review");
  });
});

describe("the parent's owner sending a child back", () => {
  it("is a review bounce: rounds counts, the feedback is posted as a comment", async () => {
    const { child } = treeInReview(workItems, "Bounce");
    const owner = await sessionOf("owner-dev");

    const res = await statusPost(owner.id, child.id, sendBack);

    expect([res.status, res.body.workItem.status, res.body.workItem.rounds]).toEqual([200, "executing", 1]);
    const event = lastMove(child.id);
    expect(event.detail).toMatchObject({ bounce: true, rounds: 1, parentOwner: true, note: sendBack.note });
    expect(listComments(child.id).comments.map((comment) => [comment.body, comment.author])).toEqual([[sendBack.note, "owner-dev"]]);

    transition(child.id, "in_review", "child-dev", { manual: true, agent: true });
    const second = await statusPost(owner.id, child.id, sendBack);
    expect([second.status, second.body.workItem.rounds]).toEqual([200, 2]);
  });

  it("needs the feedback", async () => {
    const { child } = treeInReview(workItems, "Bounce without a note");
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, { status: "executing" });
    expect([res.status, res.body.error]).toEqual([400, expect.stringMatching(/needs the feedback in note/)]);
    expect(statusOf(child.id)).toBe("in_review");
  });

  it("is kept as a declared bounce by the reconciler", async () => {
    const { isReviewBounceDeclared } = await import("../../work-items/event-log.js");
    const { child } = treeInReview(workItems, "Declared bounce");
    await statusPost((await sessionOf("owner-dev")).id, child.id, sendBack);
    expect(isReviewBounceDeclared(child.id)).toBe(true);
  });
});

describe("what the parent-owner lane refuses", () => {
  it("does not cancel", async () => {
    const { child } = treeInReview(workItems, "Cancel");
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, { status: "cancelled", note: "no longer needed" });
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/cancelling.*operator's decision/)]);
    expect(statusOf(child.id)).toBe("in_review");
  });

  it("does not reopen a closed child, nor re-close it", async () => {
    const { child } = treeInReview(workItems, "Closed");
    transition(child.id, "done", "operator", { human: true });
    const owner = await sessionOf("owner-dev");
    for (const body of [accept, sendBack, { status: "backlog", note: "again" }]) {
      const res = await statusPost(owner.id, child.id, body);
      expect(res.status).toBe(403);
    }
    expect(statusOf(child.id)).toBe("done");
  });

  it("does not cascade over open descendants", async () => {
    const { child } = treeInReview(workItems, "Cascade");
    const grandchild = workItems.createWorkItem({ title: "Open grandchild", parentId: child.id, status: "executing" });
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, { ...accept, cascade: true });
    expect(res.status).toBe(403);
    expect([statusOf(child.id), statusOf(grandchild.id)]).toEqual(["in_review", "executing"]);
  });

  it.each(["backlog", "executing", "blocked"] as const)("does not close a child that is %s", async (status) => {
    const { child } = treeInReview(workItems, `Child ${status}`);
    transition(child.id, status === "backlog" ? "executing" : status, "operator", { human: true, blockKind: "needs_input" });
    if (status === "backlog") transition(child.id, "backlog", "operator", { human: true });
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/operator's decision/)]);
    expect(statusOf(child.id)).toBe(status);
    expect(listComments(child.id).total).toBe(0);
  });

  it("does not accept a child whose parent it does not own, and its send-back is no review bounce", async () => {
    const { child } = treeInReview(workItems, "Someone else's parent");
    const other = await sessionOf("third-dev");

    const refused = await statusPost(other.id, child.id, accept);
    expect([refused.status, statusOf(child.id)]).toEqual([403, "in_review"]);

    // Moving work out of review is an ordinary agent move for any session; only the addressee's is the bounce.
    const moved = await statusPost(other.id, child.id, sendBack);
    expect([moved.status, moved.body.workItem.rounds]).toEqual([200, 0]);
    expect(lastMove(child.id).detail).not.toHaveProperty("bounce");
  });

  it("does not accept a root Todo, nor a child of an operator-owned parent", async () => {
    const root = workItems.createWorkItem({ title: "Root", status: "in_review", assignee: "owner-dev" });
    const { child } = treeInReview(workItems, "Operator parent", { parentOwner: "@operator" });
    const owner = await sessionOf("owner-dev");
    for (const id of [root.id, child.id]) {
      const res = await statusPost(owner.id, id, accept);
      expect([res.status, statusOf(id)]).toEqual([403, "in_review"]);
    }
  });

  it("does not let the child's own producer close it", async () => {
    const { child } = treeInReview(workItems, "Producer");
    const res = await statusPost((await sessionOf("child-dev")).id, child.id, accept);
    expect([res.status, statusOf(child.id)]).toEqual([403, "in_review"]);
  });

  it("holds the self-review ban: an owner that worked the child cannot accept it", async () => {
    const { child } = treeInReview(workItems, "Linked owner");
    const owner = await sessionOf("owner-dev");
    workItems.linkSession(child.id, owner.id);
    const res = await statusPost(owner.id, child.id, accept);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner-dev cannot accept .*: a session of owner-dev was linked to work on it.*self-review ban/);
    expect([statusOf(child.id), listComments(child.id).total]).toEqual(["in_review", 0]);
  });

  it("holds the ban for a second session of an owner that started or handed in the child", async () => {
    const parent = workItems.createWorkItem({ title: "Parent", status: "executing", assignee: "owner-dev" });
    const child = workItems.createWorkItem({ title: "Owner-made child", status: "backlog", parentId: parent.id });
    const first = await sessionOf("owner-dev");
    expect((await statusPost(first.id, child.id, { status: "executing" })).status).toBe(200);
    expect((await statusPost(first.id, child.id, { status: "in_review", note: "I did it myself" })).status).toBe(200);

    const second = await sessionOf("owner-dev", { parentSessionId: first.id });
    const res = await statusPost(second.id, child.id, accept);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner-dev moved it to executing/);
    expect(statusOf(child.id)).toBe("in_review");
  });

  it("treats an owner's own take-back of work it handed in as an ordinary agent move, not a review bounce", async () => {
    const { child } = treeInReview(workItems, "Own take-back");
    const owner = await sessionOf("owner-dev");
    workItems.linkSession(child.id, owner.id);
    const res = await statusPost(owner.id, child.id, sendBack);
    expect([res.status, res.body.workItem.rounds]).toEqual([200, 0]);
    expect(lastMove(child.id).detail).not.toHaveProperty("parentOwner");
  });

  it("lets a reviewer session of the owner, linked as the reviewer, accept it", async () => {
    const { child } = treeInReview(workItems, "Reviewer link");
    const owner = await sessionOf("owner-dev");
    workItems.linkSession(child.id, owner.id, null, "review");
    const res = await statusPost(owner.id, child.id, accept);
    expect([res.status, statusOf(child.id)]).toEqual([200, "done"]);
  });
});

describe("the addressee is read live", () => {
  it("stops serving a parent's owner once the parent is reassigned, and serves the new owner", async () => {
    const { parent, child } = treeInReview(workItems, "Reassign");
    const owner = await sessionOf("owner-dev");
    const successor = await sessionOf("third-dev");

    assignWorkItem(parent.id, "third-dev", "engineering", "operator");

    expect((await statusPost(owner.id, child.id, accept)).status).toBe(403);
    expect((await statusPost(successor.id, child.id, accept)).status).toBe(200);
  });

  it("returns the review to the operator once the parent goes to the operator", async () => {
    const { parent, child } = treeInReview(workItems, "To operator");
    assignWorkItem(parent.id, "@operator", null, "operator");
    expect((await statusPost((await sessionOf("owner-dev")).id, child.id, accept)).status).toBe(403);
    const operator = await call("PUT", `/api/work-items/${child.id}/status`, { status: "done" });
    expect([operator.status, statusOf(child.id)]).toEqual([200, "done"]);
  });
});
