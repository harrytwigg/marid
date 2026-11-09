import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";

// `freshSession` on a delegation: the employee's live session on the Todo is
// ended and a new one is spawned and linked in its place, so the next phase of
// the work starts with a clean context and the Todo keeps a live run behind it.
mentionTestHome("jinn-todo-delegation-fresh-");

vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return { ...actual, deliverClaimedSessionDelivery: async () => "accepted" as const };
});

let h: Awaited<ReturnType<typeof loadMentionHarness>>;
let reconcile: typeof import("../../work-items/reconcile.js");
let stopped: typeof import("../../sessions/stopped-marker.js");
beforeAll(async () => {
  h = await loadMentionHarness();
  reconcile = await import("../../work-items/reconcile.js");
  stopped = await import("../../sessions/stopped-marker.js");
});

interface FreshOptions { employee?: string; headers?: Record<string, string>; idempotencyKey?: string; freshSession?: unknown }

function delegateFresh(todoId: string, opts: FreshOptions = {}) {
  return h.call("POST", "/api/delegations", {
    workItemId: todoId, employee: opts.employee ?? "worker", task: `Next phase of ${todoId}.`,
    freshSession: "freshSession" in opts ? opts.freshSession : true,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  }, opts.headers);
}

/** The session's turn ends cleanly, a moment after everything before it. */
function settle(sessionId: string) {
  return h.registry.updateSession(sessionId, {
    status: "idle", attemptOutcome: "succeeded", attemptTerminalVersion: 1, lastActivity: new Date(Date.now() + 1000).toISOString(),
  })!;
}

const statusOf = (todoId: string) => h.store.getWorkItem(todoId)?.status;

describe("a fresh-session delegation onto a Todo the employee already has a session on", () => {
  it("ends the running session and spawns and links a new one in its place", async () => {
    const item = h.store.createWorkItem({ title: "phase two", assignee: "worker", status: "executing" });
    const old = h.executing(item.id);

    const res = await delegateFresh(item.id);

    expect(res.status).toBe(201);
    expect(res.body.sessionId).not.toBe(old.id);
    expect(res.body.replacedSessionId).toBe(old.id);
    const fresh = h.registry.getSession(res.body.sessionId)!;
    expect(fresh).toMatchObject({ workItemId: item.id, workItemRole: "execute", employee: "worker", status: "running" });
    expect(h.registry.getSession(old.id)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
    expect(stopped.isStoppedByUser(old)).toBe(true);
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(fresh.id);
    expect(h.records.liveEmployeeSession(item.id, "worker")?.id).toBe(fresh.id);
    expect(statusOf(item.id)).toBe("executing");
  });

  it("replaces an idle session too, leaving its finished turn as it was", async () => {
    const item = h.store.createWorkItem({ title: "phase one done", assignee: "worker", status: "executing" });
    const old = h.executing(item.id);
    settle(old.id);

    const res = await delegateFresh(item.id);

    expect(res).toMatchObject({ status: 201, body: { replacedSessionId: old.id } });
    expect(h.registry.getSession(old.id)).toMatchObject({ status: "idle", attemptOutcome: "succeeded" });
    expect(stopped.isStoppedByUser(old)).toBe(true);
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(res.body.sessionId);
  });

  it("is an ordinary delegation when the employee has no live session on the Todo", async () => {
    const item = h.store.createWorkItem({ title: "first phase" });

    const res = await delegateFresh(item.id);

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("replacedSessionId");
    expect(h.sessionsOf(item.id, "worker")).toHaveLength(1);
  });

  it("sends a later mention to the new session, never the ended one", async () => {
    const item = h.store.createWorkItem({ title: "who answers now", assignee: "worker", status: "executing" });
    const old = h.executing(item.id);
    const res = await delegateFresh(item.id);

    await h.comment(item.id, "@worker how is it going?");

    expect(h.deliveriesTo(res.body.sessionId, "todo-mention")).toHaveLength(1);
    expect(h.deliveriesTo(old.id, "todo-mention")).toEqual([]);
  });

  it("returns the first receipt on a retry with the same key, ending nothing more", async () => {
    const item = h.store.createWorkItem({ title: "retried", assignee: "worker", status: "executing" });
    h.executing(item.id);
    const first = await delegateFresh(item.id, { idempotencyKey: "retried-phase-2" });

    const retry = await delegateFresh(item.id, { idempotencyKey: "retried-phase-2" });

    expect(retry).toMatchObject({ status: 200, body: { sessionId: first.body.sessionId, replayed: true } });
    expect(stopped.isStoppedByUser({ id: first.body.sessionId })).toBe(false);
    expect(h.registry.getSession(first.body.sessionId)?.status).toBe("running");
  });

  it("without the flag still lands in the live session, as before", async () => {
    const item = h.store.createWorkItem({ title: "same session", assignee: "worker", status: "executing" });
    const old = h.executing(item.id);

    const res = await delegateFresh(item.id, { freshSession: false });

    expect(res).toMatchObject({ status: 200, body: { sessionId: old.id, reused: true } });
    expect(stopped.isStoppedByUser(old)).toBe(false);
  });
});

describe("what a fresh-session delegation refuses, leaving the live session running", () => {
  it("refuses a freshSession that is not a boolean, before minting anything", async () => {
    const before = h.store.listWorkItems({}).length;

    const res = await h.call("POST", "/api/delegations", { employee: "worker", task: "mint me", freshSession: "yes" });

    expect(res).toMatchObject({ status: 400, body: { error: "freshSession must be a boolean when provided" } });
    expect(h.store.listWorkItems({})).toHaveLength(before);
  });

  it("refuses to end the session making the call", async () => {
    const item = h.store.createWorkItem({ title: "my own phase", assignee: "worker", status: "executing" });
    const own = h.executing(item.id);

    const res = await delegateFresh(item.id, { headers: sessionHeaders(own.id) });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("the session making this call");
    expect(stopped.isStoppedByUser(own)).toBe(false);
    expect(h.registry.getSession(own.id)?.status).toBe("running");
  });

  it("refuses to end a session the caller reports to", async () => {
    const item = h.store.createWorkItem({ title: "my manager's phase", assignee: "worker", status: "executing" });
    const manager = h.executing(item.id);
    // A helper the worker's session started: it may delegate the worker's Todo, and it reports to that session.
    const report = h.registry.createSession({
      engine: "codex", source: "web", sourceRef: `report:${crypto.randomUUID()}`, employee: "worker", connector: "web", parentSessionId: manager.id,
    });

    const res = await delegateFresh(item.id, { headers: sessionHeaders(report.id) });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("which your session reports to");
    expect(stopped.isStoppedByUser(manager)).toBe(false);
  });

  it("leaves the session alone when another employee's running session holds the Todo", async () => {
    const item = h.store.createWorkItem({ title: "someone else is on it", assignee: "worker", status: "executing" });
    h.executing(item.id);
    await h.comment(item.id, "@alpha have a look");
    const [mentioned] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(mentioned.id, { status: "idle" });

    const res = await delegateFresh(item.id, { employee: "alpha" });

    expect(res.status).toBe(409);
    expect(stopped.isStoppedByUser(mentioned)).toBe(false);
  });

  it("leaves the session alone when the new one cannot be started", async () => {
    // `offline` runs on an engine the gateway has configured but cannot run.
    const item = h.store.createWorkItem({ title: "nowhere to run", assignee: "offline", status: "executing" });
    const old = h.executing(item.id, "offline");

    const res = await delegateFresh(item.id, { employee: "offline" });

    expect(res.status).toBe(502);
    expect(stopped.isStoppedByUser(old)).toBe(false);
    expect(h.registry.getSession(old.id)?.status).toBe("running");
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(old.id);
  });
});

describe("the reconciler and a Todo whose phases run in fresh sessions", () => {
  it("keeps the Todo executing while the new session runs and after it settles", async () => {
    const item = h.store.createWorkItem({ title: "long todo", assignee: "worker", status: "executing" });
    h.executing(item.id);
    const res = await delegateFresh(item.id);

    reconcile.reconcileActiveWorkItems();
    expect(statusOf(item.id)).toBe("executing");

    settle(res.body.sessionId);
    reconcile.reconcileActiveWorkItems();
    expect(statusOf(item.id)).toBe("executing");
  });

  it("runs phase after phase, each in its own session, without the Todo being blocked", async () => {
    const item = h.store.createWorkItem({ title: "three phases", assignee: "worker", status: "executing" });
    const sessions = [h.executing(item.id).id];
    for (let phase = 2; phase <= 3; phase++) {
      const res = await delegateFresh(item.id, { idempotencyKey: `${item.id}-phase-${phase}` });
      expect(res).toMatchObject({ status: 201, body: { replacedSessionId: sessions.at(-1) } });
      sessions.push(res.body.sessionId);
      reconcile.reconcileActiveWorkItems();
      expect(statusOf(item.id)).toBe("executing");
    }
    expect(new Set(sessions).size).toBe(3);
    expect(h.sessionsOf(item.id, "worker").filter((session) => !stopped.isStoppedByUser(session)).map((session) => session.id))
      .toEqual([sessions[2]]);
  });

  it("still blocks an executing Todo whose only session was stopped", async () => {
    const item = h.store.createWorkItem({ title: "orphaned", assignee: "worker", status: "executing" });
    const only = h.executing(item.id);

    const res = await h.call("POST", `/api/sessions/${only.id}/stop`, {});
    expect(res.status).toBe(200);
    reconcile.reconcileActiveWorkItems();

    expect(statusOf(item.id)).toBe("blocked");
  });

  it("still blocks it when the next phase was spawned without being linked", async () => {
    const item = h.store.createWorkItem({ title: "unlinked next phase", assignee: "worker", status: "executing" });
    const only = h.executing(item.id);
    await h.call("POST", `/api/sessions/${only.id}/stop`, {});
    const unlinked = h.employeeSession("worker");
    h.registry.updateSession(unlinked.id, { status: "running" });

    reconcile.reconcileActiveWorkItems();

    expect(h.registry.getSession(unlinked.id)?.workItemId ?? null).toBeNull();
    expect(statusOf(item.id)).toBe("blocked");
  });
});
