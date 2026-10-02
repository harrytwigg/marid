import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";
import { todoDispatcherSessionKey } from "../work-item-authority.js";

// A delegation onto a Todo where the employee already has a session lands in
// it: the claim, the link role and who the session reports to.
mentionTestHome("jinn-todo-delegation-reuse-");

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

describe("delegation onto a Todo where the employee already has a session", () => {
  it("lands in the mention session, which takes the claim and the execute role", async () => {
    const item = h.store.createWorkItem({ title: "mentioned, then handed over" });
    await h.comment(item.id, "@alpha can you look?");
    const [mentioned] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(mentioned.id, { status: "idle" });

    const res = await h.delegate(item.id, "alpha");

    expect(res).toMatchObject({ status: 200, body: { sessionId: mentioned.id, reused: true } });
    expect(h.sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(h.registry.getSession(mentioned.id)?.workItemRole).toBe("execute");
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(mentioned.id);
    expect(h.deliveriesTo(mentioned.id, "todo-delegation")).toHaveLength(1);
    expect(h.store.getWorkItem(item.id)?.assignee).toBe("alpha");
  });

  it("lands the Dispatcher's hand-off in the mention session instead of starting a second one", async () => {
    const item = h.store.createWorkItem({ title: "dispatched after a mention" });
    await h.comment(item.id, "@alpha have a look first");
    const [mentioned] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(mentioned.id, { status: "idle" });
    const sessionKey = todoDispatcherSessionKey(item.id);
    const dispatcher = h.registry.createSession({ engine: "codex", source: "web", sourceRef: sessionKey, sessionKey, employee: "todo-dispatcher", connector: "web" });
    h.store.linkSession(item.id, dispatcher.id);
    h.registry.updateSession(dispatcher.id, { status: "running" });
    h.claims.claimWorkItem({ workItemId: item.id, owner: `dispatch:${crypto.randomUUID()}`, sessionId: dispatcher.id });

    const res = await h.delegate(item.id, "alpha", sessionHeaders(dispatcher.id));

    expect(res).toMatchObject({ status: 200, body: { sessionId: mentioned.id, reused: true } });
    expect(h.sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(mentioned.id);
    expect(h.delegation.reportingParentSessionId(h.runBriefTurn(mentioned.id))).toBe(dispatcher.id);
  });

  it("keeps an executor an executor when a review delegation lands in its session", async () => {
    const item = h.store.createWorkItem({ title: "back to the producer", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);
    h.registry.updateSession(holder.id, { status: "idle" });
    h.forceStatus(item.id, "in_review");

    expect((await h.delegate(item.id, "worker")).body.reused).toBe(true);

    expect(h.registry.getSession(holder.id)?.workItemRole).toBe("execute");
  });

  it("delivers into the employee's own running session that already holds the claim", async () => {
    const item = h.store.createWorkItem({ title: "more for the worker", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);

    const res = await h.delegate(item.id, "worker");

    expect(res).toMatchObject({ status: 200, body: { sessionId: holder.id, reused: true } });
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(holder.id);
  });

  it("is refused while another employee's session holds the claim", async () => {
    const item = h.store.createWorkItem({ title: "someone else has it", assignee: "worker", status: "executing" });
    h.executing(item.id);
    await h.comment(item.id, "@alpha thoughts?");

    expect((await h.delegate(item.id, "alpha")).status).toBe(409);
    expect(h.registry.getSession(h.sessionsOf(item.id, "alpha")[0].id)?.workItemRole).toBe("consult");
  });

  it("records a new delegate session so a later mention lands in it", async () => {
    const item = h.store.createWorkItem({ title: "delegated first" });
    const res = await h.delegate(item.id, "bravo");
    expect(res.status).toBe(201);

    await h.comment(item.id, "@bravo a question");

    expect(h.sessionsOf(item.id, "bravo").map((session) => session.id)).toEqual([res.body.sessionId]);
    expect(h.deliveriesTo(res.body.sessionId, "todo-mention")).toHaveLength(1);
  });

  it("reports to the new delegator from then on, and never wakes the session's first parent", async () => {
    const item = h.store.createWorkItem({ title: "changing hands" });
    const firstParent = h.employeeSession("org-root");
    const first = await h.delegate(item.id, "alpha", sessionHeaders(firstParent.id));
    expect(first.status).toBe(201);
    h.registry.updateSession(first.body.sessionId, { status: "idle" });
    h.claims.releaseWorkItemClaimForSession(first.body.sessionId);
    const delegator = h.employeeSession("org-root");

    const second = await h.delegate(item.id, "alpha", sessionHeaders(delegator.id));
    expect(second).toMatchObject({ status: 200, body: { sessionId: first.body.sessionId, reused: true } });

    // Until the brief's turn starts, the session's turn is still the first delegator's.
    const child = h.registry.getSession(first.body.sessionId)!;
    expect(child.parentSessionId).toBe(firstParent.id);
    expect(h.delegation.reportingParentSessionId(child)).toBe(firstParent.id);
    expect(h.delegation.reportingParentSessionId(h.runBriefTurn(child.id))).toBe(delegator.id);
    const settled = h.registry.updateSession(child.id, { attemptOutcome: "succeeded", attemptTerminalVersion: 1 })!;
    await h.callbacks.notifyParentSessionAndWait(settled, { result: "Done: took it over and finished." });
    expect(h.deliveriesTo(delegator.id, "parent-completion")).toHaveLength(1);
    expect(h.deliveriesTo(firstParent.id, "parent-completion")).toEqual([]);
  });

  it("calls nobody back when the operator delegated into the session", async () => {
    const item = h.store.createWorkItem({ title: "operator takes over" });
    const parent = h.employeeSession("org-root");
    const first = await h.delegate(item.id, "bravo", sessionHeaders(parent.id));
    h.registry.updateSession(first.body.sessionId, { status: "idle" });
    h.claims.releaseWorkItemClaimForSession(first.body.sessionId);

    expect((await h.delegate(item.id, "bravo")).body.reused).toBe(true);

    expect(h.delegation.reportingParentSessionId(h.runBriefTurn(first.body.sessionId))).toBeNull();
  });
});
