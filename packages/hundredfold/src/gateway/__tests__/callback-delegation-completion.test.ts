import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptWithoutExecuting,
  callbacks,
  completeChildAttempt,
  createChild,
  createParent,
  dbModule,
  eventually,
  makeContext,
  makeEngine,
  queueModule,
  registry,
  resetCallbackState,
  workItems,
} from "./helpers/callback-harness.js";
import { withRouteBackedFetch } from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

describe("delegation completion contract over the callback path", () => {
  it("keeps repeated rate-limit lifecycle callbacks nonterminal and independent from completion", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const queue = new queueModule.SessionQueue();
    const context = makeContext(makeEngine(seenPrompts), queue, events);
    const parent = createParent("rate-lifecycle");
    const item = workItems.createWorkItem({
      title: "Complete work after the rate limit clears",
      status: "executing",
      source: "delegation",
    });
    const child = createChild(parent.id, "rate-lifecycle-child", {
      transportMeta: { delegationCompletionTracked: true },
      prompt: "complete after a rate limit",
    });
    workItems.linkSession(item.id, child.id);
    registry.applyBlockEnvelope(parent.id, {
      op: "put",
      block: {
        id: `dg-${item.id}`,
        type: "delegation",
        version: 1,
        status: "running",
        payload: {
          employee: "worker",
          employeeDisplay: "Worker",
          title: item.title,
          childSessionId: child.id,
          workItemId: item.id,
          dispatchedAt: Date.now(),
        },
      },
    });
    completeChildAttempt(child.id);
    expect(registry.claimDelegationCompletionNudge(child.id, item.id)).toBeTruthy();
    const rateLimited = registry.getSession(child.id)!;

    await withRouteBackedFetch(context, {}, async () => {
      for (let index = 0; index < 4; index++) callbacks.notifyRateLimited(rateLimited);

      await eventually(() => {
        expect(queue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toHaveLength(1);
      });
      const rateLimitedPayload = JSON.parse((dbModule.initDb().prepare(`
        SELECT payload FROM callback_deliveries WHERE delivery_kind = 'rate-limited'
      `).get() as { payload: string }).payload) as Record<string, unknown>;
      expect(rateLimitedPayload).not.toHaveProperty("meta");
      expect(rateLimitedPayload).not.toHaveProperty("block");
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      });
      expect(registry.getMessages(parent.id).flatMap((message) => message.blocks ?? []))
        .toContainEqual(expect.objectContaining({ id: `dg-${item.id}`, status: "running" }));
      expect(workItems.getWorkItem(item.id)).toMatchObject({ status: "executing", closedAt: null });

      for (let index = 0; index < 4; index++) callbacks.notifyRateLimitResumed(rateLimited);
      for (let index = 0; index < 4; index++) {
        callbacks.notifyParentSession(rateLimited, { result: "one final escalation" });
      }

      await eventually(() => {
        expect(queue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toHaveLength(3);
      });
      expect(dbModule.initDb().prepare(`
        SELECT delivery_kind AS kind, COUNT(*) AS n
        FROM callback_deliveries
        GROUP BY delivery_kind
        ORDER BY delivery_kind
      `).all()).toEqual([
        { kind: "parent-completion", n: 1 },
        { kind: "rate-limit-resumed", n: 1 },
        { kind: "rate-limited", n: 1 },
      ]);
      expect(registry.getMessages(parent.id).filter((message) => message.meta?.kind === "child-reply"))
        .toHaveLength(1);
      expect(registry.getMessages(parent.id).flatMap((message) => message.blocks ?? []))
        .toContainEqual(expect.objectContaining({ id: `dg-${item.id}`, status: "done" }));
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "surfaced" },
      });
      expect(events.filter(({ event, data }) =>
        event === "session:notification"
        && (data as { meta?: { kind?: string } }).meta?.kind === "child-reply",
      )).toHaveLength(1);
    });
  });

  it("retains the completion guard and suppresses the parent when nudge acceptance loses its response", async () => {
    const seenPrompts: string[] = [];
    const context = makeContext(makeEngine(seenPrompts), acceptWithoutExecuting());
    const parent = createParent("nudge-response-loss");
    const item = workItems.createWorkItem({
      title: "Complete bounded callback work",
      status: "executing",
      source: "delegation",
    });
    const child = createChild(parent.id, "callback-child:nudge-response-loss", {
      transportMeta: { delegationCompletionTracked: true },
    });
    workItems.linkSession(item.id, child.id);
    const completed = completeChildAttempt(child.id);

    // The nudge reaches the child's route and commits, but the caller never
    // sees the response — the guard must hold anyway.
    await withRouteBackedFetch(context, { throwAfterAccepted: 1 }, async (routeFetch) => {
      callbacks.notifyParentSession(completed, {
        result: "Progress update: I will continue with the remaining implementation.",
      });

      await eventually(() => {
        const receipt = dbModule.initDb().prepare(`
          SELECT status FROM callback_deliveries WHERE delivery_kind = 'delegation-completion-nudge'
        `).get();
        expect(receipt).toEqual({ status: "accepted" });
      });
      expect(routeFetch).toHaveBeenCalledOnce();
      expect(registry.getMessages(child.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(registry.getMessages(parent.id)).toEqual([]);
      expect(dbModule.initDb().prepare(`
        SELECT COUNT(*) AS n FROM callback_deliveries WHERE delivery_kind = 'parent-completion'
      `).get()).toEqual({ n: 0 });
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      });
    });
  });
});
