import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome } from "./todo-mentions-harness.js";

// Who a comment wakes: mentions and replies on a Todo.
mentionTestHome("jinn-todo-mentions-");

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

describe("mentions", () => {
  it("starts one linked consult session per mentioned employee without disturbing the claim holder", async () => {
    const item = h.store.createWorkItem({ title: "two opinions", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);

    await h.comment(item.id, "@alpha and @bravo, does this look right?");

    for (const employee of ["alpha", "bravo"]) {
      const [session] = h.sessionsOf(item.id, employee);
      expect(h.sessionsOf(item.id, employee)).toHaveLength(1);
      expect(session).toMatchObject({ workItemRole: "consult", parentSessionId: null });
      expect(h.registry.getMessages(session.id)[0].content).toContain(`You were tagged in this comment on Todo ${item.id}`);
      expect(h.records.getEmployeeSessionRecord(item.id, employee)?.sessionId).toBe(session.id);
    }
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(holder.id);
    expect(h.store.getWorkItem(item.id)).toMatchObject({ status: "executing", assignee: "worker" });
  });

  it("delivers a repeat mention, in a later comment or a reply, into the same session", async () => {
    const item = h.store.createWorkItem({ title: "keep asking alpha" });
    const first = await h.comment(item.id, "@alpha first question");
    const [session] = h.sessionsOf(item.id, "alpha");

    await h.comment(item.id, "@alpha second question");
    await h.comment(item.id, "and @Alpha, in the thread", { parentCommentId: first.id });

    expect(h.sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(h.deliveriesTo(session.id, "todo-mention")).toHaveLength(2);
  });

  it("delivers into the execution session an employee already holds on the Todo", async () => {
    const item = h.store.createWorkItem({ title: "ask the worker", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);

    await h.comment(item.id, "@worker how is it going?");

    expect(h.sessionsOf(item.id, "worker").map((session) => session.id)).toEqual([holder.id]);
    expect(h.deliveriesTo(holder.id, "todo-mention")).toHaveLength(1);
    expect(h.registry.getSession(holder.id)?.workItemRole).toBe("execute");
  });

  it.each(["idle", "waiting", "interrupted"] as const)("delivers into the employee's %s session", async (status) => {
    const item = h.store.createWorkItem({ title: `alpha is ${status}` });
    await h.comment(item.id, "@alpha are you there?");
    const [session] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(session.id, { status });

    await h.comment(item.id, "@alpha still there?");

    expect(h.sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(h.deliveriesTo(session.id, "todo-mention")).toHaveLength(1);
  });

  it("starts a fresh session when the recorded one errored or was archived", async () => {
    const item = h.store.createWorkItem({ title: "alpha's session died" });
    await h.comment(item.id, "@alpha one");
    const [dead] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(dead.id, { status: "error" });

    await h.comment(item.id, "@alpha two");
    const fresh = h.records.getEmployeeSessionRecord(item.id, "alpha")!.sessionId;
    h.registry.updateSession(fresh, { archivedAt: new Date().toISOString() });
    await h.comment(item.id, "@alpha three");

    expect(new Set(h.sessionsOf(item.id, "alpha").map((session) => session.id)).size).toBe(3);
    expect(h.records.getEmployeeSessionRecord(item.id, "alpha")!.sessionId).not.toBe(fresh);
  });

  it("starts one session for two near-simultaneous mentions", async () => {
    const item = h.store.createWorkItem({ title: "two at once" });

    await Promise.all([h.comment(item.id, "@bravo one"), h.comment(item.id, "@bravo two")]);

    expect(h.sessionsOf(item.id, "bravo")).toHaveLength(1);
  });

  it("wakes nobody for a comment without a mention, or for names that cannot be woken", async () => {
    const item = h.store.createWorkItem({ title: "quiet", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);
    const author = h.employeeSession("alpha");

    await h.comment(item.id, "Just a note for the record.");
    await h.comment(item.id, "Mail ops@example.com, ask @nobody or @todo-dispatcher, quote `@bravo`.");
    await h.comment(item.id, "Note to self, @alpha.", { as: author.id });

    expect(h.registry.listSessionsByWorkItem(item.id).map((session) => session.id)).toEqual([holder.id]);
    expect(h.deliveriesTo(holder.id)).toEqual([]);
    expect(delivered).toEqual([]);
  });
});

describe("replies", () => {
  it("reaches the session that wrote the comment answered, though it is stored under the operator's root", async () => {
    const item = h.store.createWorkItem({ title: "threaded" });
    const root = await h.comment(item.id, "@alpha what do you think?");
    const [alpha] = h.sessionsOf(item.id, "alpha");
    const answer = await h.comment(item.id, "I think it's fine.", { as: alpha.id, parentCommentId: root.id });

    const followUp = await h.comment(item.id, "Why?", { parentCommentId: answer.id });

    expect(followUp).toMatchObject({ parentCommentId: root.id, repliedToId: answer.id });
    expect(h.deliveriesTo(alpha.id, "todo-reply")).toHaveLength(1);
  });

  it("wakes nobody for a reply to the operator's own comment", async () => {
    const item = h.store.createWorkItem({ title: "operator thread" });
    const root = await h.comment(item.id, "A plan.");
    const bravo = h.employeeSession("bravo");

    await h.comment(item.id, "Sounds good.", { as: bravo.id, parentCommentId: root.id });

    expect(delivered).toEqual([]);
  });
});
