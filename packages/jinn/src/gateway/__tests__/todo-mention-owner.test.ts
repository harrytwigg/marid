import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";
import { listWorkItemEvents } from "../../work-items/event-log.js";

// A mention of the employee whose session delegated or created the Todo: it
// reaches that session, which is linked to a Todo of its own, and starts no
// consultation beside it.
mentionTestHome("jinn-todo-mention-owner-");

const delivered = vi.hoisted(() => [] as string[]);
vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return {
    ...actual,
    deliverClaimedSessionDelivery: async (id: string) => {
      delivered.push(id);
      return "accepted" as const;
    },
  };
});

let h: Awaited<ReturnType<typeof loadMentionHarness>>;
beforeAll(async () => {
  h = await loadMentionHarness();
});
beforeEach(() => {
  delivered.length = 0;
});

/** An alpha session working a Todo of its own, which creates a child Todo. */
function ownerWithChild(title: string) {
  const parent = h.store.createWorkItem({ title: `${title} (parent)`, assignee: "alpha", status: "executing" });
  const owner = h.employeeSession("alpha");
  h.store.linkSession(parent.id, owner.id);
  const child = h.store.createWorkItem({ title, source: "session", sourceRef: `session:${owner.id}:child` });
  return { owner: h.registry.getSession(owner.id)!, child };
}

/** The child delegated by the owner to worker, and worker's session on it. */
async function delegatedToWorker(title: string) {
  const { owner, child } = ownerWithChild(title);
  const res = await h.delegate(child.id, "worker", sessionHeaders(owner.id));
  expect(res.status).toBeLessThan(300);
  const [worker] = h.sessionsOf(child.id, "worker");
  return { owner, child, worker };
}

const linkedSessionIds = (todoId: string) =>
  listWorkItemEvents(todoId).filter((event) => event.kind === "session_linked").map((event) => event.detail?.sessionId);

describe("a mention of the employee who owns the Todo from outside it", () => {
  it("is delivered into the delegating session, every time, with no consult session linked", async () => {
    const { owner, child, worker } = await delegatedToWorker("delegated design");
    const linkedBefore = linkedSessionIds(child.id);

    await h.comment(child.id, "@alpha which route did you settle on?", { as: worker.id });
    await h.comment(child.id, "@alpha and the follow-up?", { as: worker.id });

    expect(h.sessionsOf(child.id, "alpha")).toEqual([]);
    expect(linkedSessionIds(child.id)).toEqual(linkedBefore);
    expect(h.deliveriesTo(owner.id, "todo-mention")).toHaveLength(2);
    expect(h.registry.getSession(owner.id)?.workItemId).not.toBe(child.id);
  });

  it("is delivered into the session that created the Todo before anyone took it", async () => {
    const { owner, child } = ownerWithChild("created, not yet delegated");

    await h.comment(child.id, "@alpha what did you mean by this?");

    expect(h.sessionsOf(child.id, "alpha")).toEqual([]);
    expect(h.deliveriesTo(owner.id, "todo-mention")).toHaveLength(1);
  });

  it("prefers the delegating session to a consultation the employee already has on the Todo", async () => {
    const { owner, child, worker } = await delegatedToWorker("consulted before the fix");
    const consult = h.employeeSession("alpha", "consult");
    h.store.linkSession(child.id, consult.id, "test", "consult");

    await h.comment(child.id, "@alpha who answers?", { as: worker.id });

    expect(h.deliveriesTo(owner.id, "todo-mention")).toHaveLength(1);
    expect(h.deliveriesTo(consult.id)).toEqual([]);
  });

  it("starts a consultation when the delegating session can no longer be messaged", async () => {
    const { owner, child, worker } = await delegatedToWorker("owner gone");
    h.registry.updateSession(owner.id, { status: "error" });

    await h.comment(child.id, "@alpha anyone there?", { as: worker.id });

    const [consult] = h.sessionsOf(child.id, "alpha");
    expect(consult).toMatchObject({ workItemRole: "consult" });
    expect(h.deliveriesTo(owner.id)).toEqual([]);
  });

  it("leaves another employee's mention to that employee's own sessions", async () => {
    const { owner, child, worker } = await delegatedToWorker("someone else asked");

    await h.comment(child.id, "@bravo a second opinion?", { as: worker.id });

    const [consult] = h.sessionsOf(child.id, "bravo");
    expect(consult).toMatchObject({ workItemRole: "consult" });
    expect(h.deliveriesTo(owner.id, "todo-mention")).toEqual([]);
  });
});

describe("a mention of an employee with no session on the Todo", () => {
  it("still starts one linked consultation", async () => {
    const item = h.store.createWorkItem({ title: "nobody owns it", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);

    await h.comment(item.id, "@alpha can you look?", { as: holder.id });

    const [consult] = h.sessionsOf(item.id, "alpha");
    expect(consult).toMatchObject({ workItemRole: "consult" });
    expect(linkedSessionIds(item.id)).toContain(consult.id);
    expect(h.deliveriesTo(holder.id)).toEqual([]);
  });
});
