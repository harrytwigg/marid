import { beforeAll, describe, expect, it } from "vitest";
import { sessionOf, startParentReviewHarness, statusPost } from "./review-addressee-harness.js";

/**
 * The parent-owner lane for a child the owner delegated, through the real
 * `handleApiRequest`: the owner accepts it (`done`, with a reason) from
 * `executing` once another employee worked it and stopped, or from `in_review`,
 * and the self-review ban holds whenever the owner had a hand in it.
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

describe("the parent's owner accepting a delegated child", () => {
  /** A child the owner created and delegated: assigned to child-dev, executing,
   *  started by the reconciler, and worked by a session of child-dev that has stopped. */
  async function delegatedChild(title: string, status: "executing" | "in_review" = "executing") {
    const parent = workItems.createWorkItem({ title: `${title} parent`, status: "executing", assignee: "owner-dev" });
    const child = workItems.createWorkItem({ title: `${title} child`, status: "executing", parentId: parent.id, assignee: "child-dev" });
    const producer = await sessionOf("child-dev");
    workItems.linkSession(child.id, producer.id, "delegation", "execute", { via: "delegation" });
    if (status === "in_review") transition(child.id, "in_review", "reconciler", { manual: true, agent: true });
    return { parent, child, producer };
  }

  it("closes it straight from executing, as itself", async () => {
    const { child } = await delegatedChild("From executing");
    const owner = await sessionOf("owner-dev");

    const res = await statusPost(owner.id, child.id, accept);

    expect([res.status, res.body.workItem.status]).toEqual([200, "done"]);
    expect(listComments(child.id).comments.map((comment) => [comment.body, comment.author])).toEqual([
      ["Accepted as done by owner-dev, who owns the parent Todo. Reason: Integrated into the parent branch", "owner-dev"],
    ]);
    expect(lastMove(child.id).detail).toMatchObject({ parentOwner: true, actorEmployee: "owner-dev" });
  });

  it("closes it after the owner itself moved it to review, since the assignee produced it", async () => {
    const { child } = await delegatedChild("Owner relays to review");
    const owner = await sessionOf("owner-dev");

    const handoff = await statusPost(owner.id, child.id, { status: "in_review", note: "Child-dev reported back" });
    expect([handoff.status, handoff.body.workItem.status]).toEqual([200, "in_review"]);

    const res = await statusPost(owner.id, child.id, accept);
    expect([res.status, statusOf(child.id)]).toEqual([200, "done"]);
  });

  it("needs the reason when closing from executing", async () => {
    const { child } = await delegatedChild("Executing without a note");
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, { status: "done" });
    expect([res.status, res.body.error]).toEqual([400, expect.stringMatching(/needs the reason in note/)]);
    expect(statusOf(child.id)).toBe("executing");
  });

  it("is still held by the open-children gate from executing", async () => {
    const { child } = await delegatedChild("Executing with open work");
    workItems.createWorkItem({ title: "Grandchild", parentId: child.id, status: "executing" });
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/still has open children/)]);
    expect(statusOf(child.id)).toBe("executing");
  });

  it("does not let another employee, nor the child's own assignee, close it from executing", async () => {
    const { child } = await delegatedChild("Not the owner");
    for (const name of ["third-dev", "child-dev"]) {
      const res = await statusPost((await sessionOf(name)).id, child.id, accept);
      expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/operator's decision/)]);
    }
    expect(statusOf(child.id)).toBe("executing");
  });

  it("refuses an owner that is the child's own assignee, from executing and from review", async () => {
    const parent = workItems.createWorkItem({ title: "Self parent", status: "executing", assignee: "owner-dev" });
    const child = workItems.createWorkItem({ title: "Self child", status: "executing", parentId: parent.id, assignee: "owner-dev" });
    const owner = await sessionOf("owner-dev");

    const fromExecuting = await statusPost(owner.id, child.id, accept);
    expect([fromExecuting.status, fromExecuting.body.error]).toEqual([403, expect.stringMatching(/operator's decision/)]);

    expect((await statusPost(owner.id, child.id, { status: "in_review", note: "Done myself" })).status).toBe(200);
    const fromReview = await statusPost(owner.id, child.id, accept);
    expect([fromReview.status, fromReview.body.error]).toEqual([403, expect.stringMatching(/owner-dev cannot accept .*owner-dev is assigned to it.*self-review ban/)]);
    expect([statusOf(child.id), listComments(child.id).comments.filter((comment) => comment.body.startsWith("Accepted")).length]).toEqual(["in_review", 0]);
  });

  it.each([["unassigned", null], ["the operator's", "@operator"], ["not an employee's", "nobody-dev"]] as const)(
    "does not close an executing child that is %s: nobody is producing it",
    async (_label, assignee) => {
      const parent = workItems.createWorkItem({ title: "Parent", status: "executing", assignee: "owner-dev" });
      const child = workItems.createWorkItem({ title: "Nobody's child", status: "executing", parentId: parent.id, ...(assignee ? { assignee } : {}) });
      const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
      expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/operator's decision/)]);
      expect([statusOf(child.id), listComments(child.id).total]).toEqual(["executing", 0]);
    },
  );

  it.each(["running", "waiting", "interrupted"] as const)("waits while the producer's session is %s, then closes once it has stopped", async (live) => {
    const { child, producer } = await delegatedChild(`Producer ${live}`);
    const { updateSession } = await import("../../sessions/registry.js");
    const owner = await sessionOf("owner-dev");

    updateSession(producer.id, { status: live });
    const early = await statusPost(owner.id, child.id, accept);
    expect([early.status, early.body.error]).toEqual([403, expect.stringMatching(new RegExp(`still being worked on: a session of child-dev is ${live}`))]);
    expect(statusOf(child.id)).toBe("executing");

    updateSession(producer.id, { status: "error" });
    const late = await statusPost(owner.id, child.id, accept);
    expect([late.status, statusOf(child.id)]).toEqual([200, "done"]);
  });

  it("does not close an executing child its assignee was never linked to work", async () => {
    const parent = workItems.createWorkItem({ title: "Unworked parent", status: "executing", assignee: "owner-dev" });
    const child = workItems.createWorkItem({ title: "Unworked child", status: "executing", parentId: parent.id, assignee: "child-dev" });
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/operator's decision/)]);
    expect(statusOf(child.id)).toBe("executing");
  });

  it("refuses the owner that relayed an unworked child into review: the handoff is its own", async () => {
    const parent = workItems.createWorkItem({ title: "Unworked relay parent", status: "executing", assignee: "owner-dev" });
    const child = workItems.createWorkItem({ title: "Unworked relay child", status: "executing", parentId: parent.id, assignee: "child-dev" });
    const owner = await sessionOf("owner-dev");
    expect((await statusPost(owner.id, child.id, { status: "in_review", note: "Nothing to report" })).status).toBe(200);
    const res = await statusPost(owner.id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/owner-dev handed it to review.*self-review ban/)]);
    expect(statusOf(child.id)).toBe("in_review");
  });

  it("refuses an owner the child was reassigned to after the producer moved it to review", async () => {
    const { child } = await delegatedChild("Reassigned to the owner", "in_review");
    assignWorkItem(child.id, "owner-dev", "engineering", "operator");
    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/owner-dev is assigned to it.*self-review ban/)]);
    expect(statusOf(child.id)).toBe("in_review");
  });

  it.each(["executing", "in_review"] as const)(
    "refuses, from %s, a later session of an owner that was linked to work the child, though another employee is now its assignee",
    async (status) => {
      const { child } = await delegatedChild(`Owner worked it ${status}`, status);
      workItems.linkSession(child.id, (await sessionOf("owner-dev")).id);
      const later = await sessionOf("owner-dev");
      const res = await statusPost(later.id, child.id, accept);
      expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/a session of owner-dev was linked to work on it.*self-review ban/)]);
      expect(statusOf(child.id)).toBe(status);
    },
  );

  it("refuses an owner that started the child itself and then reassigned it", async () => {
    const parent = workItems.createWorkItem({ title: "Started parent", status: "executing", assignee: "owner-dev" });
    const child = workItems.createWorkItem({ title: "Started child", status: "backlog", parentId: parent.id, assignee: "owner-dev" });
    const owner = await sessionOf("owner-dev");
    expect((await statusPost(owner.id, child.id, { status: "executing" })).status).toBe(200);
    assignWorkItem(child.id, "child-dev", "engineering", "operator");
    workItems.linkSession(child.id, (await sessionOf("child-dev")).id, "delegation", "execute", { via: "delegation" });

    const res = await statusPost((await sessionOf("owner-dev")).id, child.id, accept);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/owner-dev (moved it to executing|was linked to work on it|cannot accept).*self-review ban/)]);
    expect(statusOf(child.id)).toBe("executing");
  });
});
