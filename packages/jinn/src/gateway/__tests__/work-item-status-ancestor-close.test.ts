import { beforeAll, describe, expect, it } from "vitest";
import { sessionOf, startParentReviewHarness, statusPost } from "./review-addressee-harness.js";

/**
 * The ancestor-owner close, through the real `handleApiRequest`: an employee
 * that owns an `executing` or `blocked` Todo above another closes that Todo from
 * review as done, with a note, at any depth and whoever produced it, its own work
 * included. A root has no ancestor and never qualifies.
 *
 *   owner-dev:  owns the root (A)
 *   child-dev:  owns the middle Todo (B)
 *   third-dev:  outside the tree (C)
 */

let workItems: Awaited<ReturnType<typeof startParentReviewHarness>>["workItems"];
let listComments: typeof import("../../work-items/comments.js").listComments;
let listWorkItemEvents: typeof import("../../work-items/event-log.js").listWorkItemEvents;
let updateSession: typeof import("../../sessions/registry.js").updateSession;
let transition: typeof import("../../work-items/transitions.js").transition;
let initDb: typeof import("../../shared/db.js").initDb;

beforeAll(async () => {
  ({ workItems } = await startParentReviewHarness());
  ({ listComments } = await import("../../work-items/comments.js"));
  ({ listWorkItemEvents } = await import("../../work-items/event-log.js"));
  ({ updateSession } = await import("../../sessions/registry.js"));
  ({ transition } = await import("../../work-items/transitions.js"));
  ({ initDb } = await import("../../shared/db.js"));
});

type Status = "backlog" | "executing" | "in_review" | "blocked" | "done";
const statusOf = (id: string) => workItems.getWorkItem(id)?.status;
const lastMove = (id: string) => listWorkItemEvents(id).filter((event) => event.toStatus !== null).at(-1)!;
const closeBody = { status: "done", note: "Landed in the root's deliverable" };
const operatorsDecision = /closing Todo \S+ is the operator's decision/;

const todo = (title: string, status: Status, assignee: string | null, parentId?: string) =>
  workItems.createWorkItem({ title, status, ...(assignee ? { assignee } : {}), ...(parentId ? { parentId } : {}) });

/** A Todo `employee` produced: worked in a session that has since stopped, then handed to review. */
async function produced(title: string, parentId: string, employee: string) {
  const item = todo(title, "executing", employee, parentId);
  workItems.linkSession(item.id, (await sessionOf(employee)).id, "delegation", "execute", { via: "delegation" });
  transition(item.id, "in_review", "reconciler", { manual: true, agent: true });
  return item;
}

/** The root `R` A owns, C1 (A's own work), C2 (B's), and a review-ready grandchild G of C2 that B produced. */
async function tree(title: string) {
  const root = todo(`${title} root`, "executing", "owner-dev");
  const own = todo(`${title} C1`, "backlog", "owner-dev", root.id);
  const owner = await sessionOf("owner-dev");
  expect((await statusPost(owner.id, own.id, { status: "executing" })).status).toBe(200);
  expect((await statusPost(owner.id, own.id, { status: "in_review", note: "Did it myself" })).status).toBe(200);
  const middle = todo(`${title} C2`, "executing", "child-dev", root.id);
  const grandchild = await produced(`${title} G`, middle.id, "child-dev");
  return { root, own, middle, grandchild, owner };
}

describe("the repro: A owns the root, closes its own work and a grandchild, then the middle Todo", () => {
  it("closes C1, the work A produced, from review and marks it as its own work", async () => {
    const { own, owner } = await tree("Own work");
    const res = await statusPost(owner.id, own.id, closeBody);
    expect([res.status, statusOf(own.id)]).toEqual([200, "done"]);
    expect(lastMove(own.id).detail).toMatchObject({ parentOwner: true, ownWork: true, note: closeBody.note, actorEmployee: "owner-dev" });
    expect(lastMove(own.id).detail).not.toHaveProperty("ancestorOwner");
    expect(listComments(own.id).comments.at(-1)?.body).toBe(`Accepted as done by owner-dev, who owns the parent Todo. Reason: ${closeBody.note}`);
  });

  it("closes the grandchild G of another employee's Todo, naming the ancestor", async () => {
    const { root, grandchild, owner } = await tree("Grandchild");
    const res = await statusPost(owner.id, grandchild.id, closeBody);
    expect([res.status, statusOf(grandchild.id)]).toEqual([200, "done"]);
    const { detail } = lastMove(grandchild.id);
    expect(detail).toMatchObject({ parentOwner: true, ancestorOwner: root.id, actorEmployee: "owner-dev" });
    expect(detail).not.toHaveProperty("ownWork");
    expect(listComments(grandchild.id).comments.at(-1)?.body).toBe(`Accepted as done by owner-dev, who owns ancestor Todo ${root.id}. Reason: ${closeBody.note}`);
  });

  it("closes C2 only once G is closed: the open-children gate holds, then yields", async () => {
    const { middle, grandchild, owner } = await tree("Roll-up");
    expect((await statusPost((await sessionOf("child-dev")).id, middle.id, { status: "in_review", note: "Rolled up" })).status).toBe(200);

    const early = await statusPost(owner.id, middle.id, closeBody);
    expect([early.status, early.body.error]).toEqual([403, expect.stringMatching(/still has open children/)]);
    expect(statusOf(middle.id)).toBe("in_review");

    expect((await statusPost(owner.id, grandchild.id, closeBody)).status).toBe(200);
    const late = await statusPost(owner.id, middle.id, closeBody);
    expect([late.status, statusOf(middle.id)]).toEqual([200, "done"]);
  });

  it("walks up past an ancestor of its own that is not in work, to one that is", async () => {
    const root = todo("Walk root", "executing", "owner-dev");
    const parked = todo("Walk parked", "in_review", "owner-dev", root.id);
    const middle = todo("Walk middle", "executing", "child-dev", parked.id);
    const leaf = await produced("Walk leaf", middle.id, "child-dev");
    const res = await statusPost((await sessionOf("owner-dev")).id, leaf.id, closeBody);
    expect([res.status, statusOf(leaf.id)]).toEqual([200, "done"]);
    expect(lastMove(leaf.id).detail).toMatchObject({ ancestorOwner: root.id });
  });

  it("serves the owner of a blocked ancestor", async () => {
    const root = todo("Blocked root", "blocked", "owner-dev");
    const middle = todo("Blocked middle", "executing", "child-dev", root.id);
    const leaf = await produced("Blocked leaf", middle.id, "child-dev");
    expect((await statusPost((await sessionOf("owner-dev")).id, leaf.id, closeBody)).status).toBe(200);
  });

  it("lets B, the owner of C2, close the grandchild G it produced, as the ancestor owner of G", async () => {
    const { middle, grandchild } = await tree("Middle owner");
    const res = await statusPost((await sessionOf("child-dev")).id, grandchild.id, closeBody);
    expect([res.status, statusOf(grandchild.id)]).toEqual([200, "done"]);
    expect(lastMove(grandchild.id).detail).toMatchObject({ parentOwner: true, ownWork: true });
    expect(workItems.getWorkItem(middle.id)?.status).toBe("executing");
  });
});

describe("the work in flight", () => {
  it("is not held by the calling session itself, though it executed the Todo and is running", async () => {
    const { own, owner } = await tree("Caller running");
    updateSession(owner.id, { status: "running" });
    const res = await statusPost(owner.id, own.id, closeBody);
    expect([res.status, statusOf(own.id)]).toEqual([200, "done"]);
  });

  it("is held by a different live session working the Todo", async () => {
    const { own, owner } = await tree("Other live session");
    const other = await sessionOf("child-dev");
    workItems.linkSession(own.id, other.id, "delegation", "execute", { via: "delegation" });
    updateSession(other.id, { status: "running" });
    const res = await statusPost(owner.id, own.id, closeBody);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(/still being worked on: a session of child-dev is running/)]);
    expect(statusOf(own.id)).toBe("in_review");
  });
});

describe("what stays refused", () => {
  it("refuses an employee outside the tree, on C1 and on G", async () => {
    const { own, grandchild } = await tree("Outsider");
    const outsider = await sessionOf("third-dev");
    for (const id of [own.id, grandchild.id]) {
      const res = await statusPost(outsider.id, id, closeBody);
      expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
      expect(statusOf(id)).toBe("in_review");
    }
  });

  it("refuses B closing C2, the Todo it owns: it has no ancestor of C2 of its own", async () => {
    const { middle } = await tree("Own middle");
    const b = await sessionOf("child-dev");
    expect((await statusPost(b.id, middle.id, { status: "in_review", note: "Rolled up" })).status).toBe(200);
    updateSession(b.id, { status: "idle" });
    const res = await statusPost(b.id, middle.id, closeBody);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
  });

  it("refuses A closing the root: a root's review is the operator's", async () => {
    const { root, owner } = await tree("Root");
    expect(workItems.getWorkItem(root.id)?.parentId).toBeNull();
    expect((await statusPost(owner.id, root.id, { status: "in_review", note: "All landed" })).status).toBe(200);
    const res = await statusPost(owner.id, root.id, closeBody);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
    expect(statusOf(root.id)).toBe("in_review");
  });

  it.each([
    ["in the backlog", "backlog", "owner-dev"],
    ["in review", "in_review", "owner-dev"],
  ] as const)("gives no standing when the ancestor is %s", async (_label, status, assignee) => {
    const ancestor = todo("Standing root", status, assignee);
    const middle = todo("Standing middle", "executing", "child-dev", ancestor.id);
    const leaf = await produced("Standing leaf", middle.id, "child-dev");
    const res = await statusPost((await sessionOf("owner-dev")).id, leaf.id, closeBody);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
    expect(statusOf(leaf.id)).toBe("in_review");
  });

  /** The caller itself is the ancestor's assignee, so only the live-org and system-employee checks refuse it. */
  it.each([["an employee missing from the org", "ghost-dev"], ["a system employee", "todo-dispatcher"]] as const)(
    "gives no standing to %s that is assigned the executing ancestor",
    async (_label, employee) => {
      const ancestor = todo("Caller root", "executing", employee);
      const middle = todo("Caller middle", "executing", "child-dev", ancestor.id);
      const leaf = await produced("Caller leaf", middle.id, "child-dev");
      const res = await statusPost((await sessionOf(employee)).id, leaf.id, closeBody);
      expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
      expect(statusOf(leaf.id)).toBe("in_review");
    },
  );

  it.each(["backlog", "executing", "blocked"] as const)("does not close a %s Todo through a non-direct ancestor", async (status) => {
    const root = todo("Open root", "executing", "owner-dev");
    const middle = todo("Open middle", "executing", "child-dev", root.id);
    const leaf = todo("Open leaf", status, "child-dev", middle.id);
    const res = await statusPost((await sessionOf("owner-dev")).id, leaf.id, closeBody);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
    expect(statusOf(leaf.id)).toBe(status);
  });

  it("needs the note, and leaves the Todo in review without it", async () => {
    const { grandchild, owner } = await tree("No note");
    for (const body of [{ status: "done" }, { status: "done", note: "  " }]) {
      const res = await statusPost(owner.id, grandchild.id, body);
      expect([res.status, res.body.error]).toEqual([400, expect.stringMatching(/needs the reason in note/)]);
    }
    expect(statusOf(grandchild.id)).toBe("in_review");
  });

  it("still refuses a cascade from an employee, whatever its standing", async () => {
    const { middle, grandchild, owner } = await tree("Cascade");
    expect((await statusPost((await sessionOf("child-dev")).id, middle.id, { status: "in_review", note: "Rolled up" })).status).toBe(200);
    const res = await statusPost(owner.id, middle.id, { ...closeBody, cascade: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect([statusOf(middle.id), statusOf(grandchild.id)]).toEqual(["in_review", "in_review"]);
  });

  it("gives no standing once the ancestor is done", async () => {
    const root = todo("Closed root", "executing", "owner-dev");
    const middle = todo("Closed middle", "executing", "child-dev", root.id);
    const leaf = await produced("Closed leaf", middle.id, "child-dev");
    initDb().prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(root.id);
    const res = await statusPost((await sessionOf("owner-dev")).id, leaf.id, closeBody);
    expect([res.status, res.body.error]).toEqual([403, expect.stringMatching(operatorsDecision)]);
    expect(statusOf(leaf.id)).toBe("in_review");
  });

  it("does not let the standing cancel a grandchild", async () => {
    const { grandchild, owner } = await tree("Cancel");
    const cancel = await statusPost(owner.id, grandchild.id, { status: "cancelled", note: "No" });
    expect([cancel.status, statusOf(grandchild.id)]).toEqual([403, "in_review"]);
  });
});
