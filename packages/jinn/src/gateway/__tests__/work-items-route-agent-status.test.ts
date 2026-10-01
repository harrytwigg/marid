import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

/* Status is the one Todo write open to every authenticated session: the
 * relationship graph that used to gate it (creator / assignee / assignee's
 * manager / bound workflow run) is gone. What an agent may do is bounded by the
 * lane instead — the open statuses only; closing is the operator's. The lane
 * matrix itself is pinned in work-items-route-status-lanes.test.ts; this file
 * keeps the cases that matter specifically because the caller is linked to the
 * Todo, or the operator surface is the control. */
describe("POST /api/work-items/:id/status — open to any authenticated session", () => {
  /** No relation to the Todo under test: not its creator, assignee, assignee's
   *  manager, linked execution attempt, or the run of any workflow. */
  function strangerSession(sourceRef: string) {
    return reg.createSession({ engine: "codex", source: "web", sourceRef, employee: "solo-worker" });
  }

  async function post(itemId: string, body: unknown, headers: Record<string, string>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${itemId}/status`, body, headers), cap.res, ctx);
    return cap;
  }

  // The old self-review ban is gone: no agent session closes a Todo at all, so
  // a link to the Todo — as its executing attempt or as a workflow phase —
  // neither earns nor costs anything on the way to done.
  it("lets a linked execution attempt hand off to review but refuses it, and a linked workflow phase, done", async () => {
    const reviewer = reg.createSession({ engine: "codex", source: "web", sourceRef: "open-status-reviewer" });
    const executor = reg.createSession({ engine: "codex", source: "web", sourceRef: "open-status-executor", parentSessionId: reviewer.id });
    const item = store.createWorkItem({
      title: "Linked executor cannot close",
      status: "executing",
      source: "delegation",
      sourceRef: `delegate:${reviewer.id}:open-status`,
    });
    store.linkSession(item.id, executor.id);

    const handed = await post(item.id, { status: "in_review" }, toolHeaders(executor.id));
    expect(handed.status).toBe(200);

    const selfClose = await post(item.id, { status: "done" }, toolHeaders(executor.id));
    expect(selfClose.status).toBe(403);
    expect(selfClose.body.error).toMatch(/operator's decision/);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    const phase = reg.createSession({
      engine: "codex",
      source: "workflow",
      sourceRef: "workflow:review-flow:run-1:verify:1",
    });
    const phaseItem = store.createWorkItem({ title: "Workflow phase cannot close", status: "in_review" });
    store.linkSession(phaseItem.id, phase.id);

    const phaseClose = await post(phaseItem.id, { status: "done" }, toolHeaders(phase.id));
    expect([phaseClose.status, store.getWorkItem(phaseItem.id)?.status]).toEqual([403, "in_review"]);
  });

  it("refuses the linked producer done even while a reviewer is linked beside it", async () => {
    const producer = reg.createSession({ engine: "codex", source: "web", sourceRef: "review-link-producer" });
    const reviewer = reg.createSession({ engine: "codex", source: "web", sourceRef: "review-link-reviewer" });
    const item = store.createWorkItem({ title: "Producer cannot close", status: "in_review", assignee: "platform-worker" });
    store.linkSession(item.id, producer.id);
    store.linkSession(item.id, reviewer.id, null, "review");

    const selfClose = await post(item.id, { status: "done" }, toolHeaders(producer.id));
    expect(selfClose.status).toBe(403);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
  });

  it.each(["backlog", "blocked"] as const)(
    "still refuses an unrelated session done from %s",
    async (status) => {
      const item = store.createWorkItem({ title: `No done shortcut from ${status}`, status });
      const session = strangerSession(`done-precondition-${status}`);

      const done = await post(item.id, { status: "done" }, toolHeaders(session.id));

      expect(done.status).toBe(403);
      expect(done.body.error).toMatch(/operator's decision/);
      expect(store.getWorkItem(item.id)?.status).toBe(status);
    },
  );

  it("leaves the operator lanes unaffected: POST done closes, PUT cancels", async () => {
    const reviewed = store.createWorkItem({ title: "Operator closes", status: "in_review" });
    const done = await post(reviewed.id, { status: "done" }, operatorHeaders);
    expect([done.status, done.body.workItem.status]).toEqual([200, "done"]);

    const live = store.createWorkItem({ title: "Operator cancels", status: "backlog", assignee: "platform-worker" });
    const cancelled = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${live.id}/status`, { status: "cancelled" }, operatorHeaders),
      cancelled.res,
      ctx,
    );
    expect([cancelled.status, cancelled.body.workItem.status]).toEqual([200, "cancelled"]);
  });
});
