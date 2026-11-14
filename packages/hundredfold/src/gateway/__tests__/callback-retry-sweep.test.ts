import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callbacks,
  completeChildAttempt,
  createChild,
  createParent,
  dbModule,
  makeContext,
  makeEngine,
  queueModule,
  registry,
  resetCallbackState,
} from "./helpers/callback-harness.js";
import { withFetch, withRouteBackedFetch } from "./helpers/callback-requests.js";

/* Fake timers throughout: the retry backoff is persisted as absolute
 * timestamps, so each test pins its own system time. Nothing here may use the
 * real-timer `eventually` helper. */
beforeEach(resetCallbackState);

afterEach(() => {
  callbacks.__resetCallbackRetrySweepForTest();
  vi.useRealTimers();
});

function createCompletedChild(parentId: string, suffix: string) {
  const child = createChild(parentId, `retry-child:${suffix}`, { prompt: "complete retry work" });
  return completeChildAttempt(child.id);
}

describe("callback live retry sweep", () => {
  it("automatically retries one pre-accept timeout after persisted backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("live-retry");
    const child = createCompletedChild(parent.id, "live-retry");

    await withRouteBackedFetch(context, { failBefore: 1 }, async (routeFetch) => {
      callbacks.notifyParentSession(child, { result: "retry once" });
      await vi.advanceTimersByTimeAsync(0);
      expect(routeFetch).toHaveBeenCalledOnce();
      const pending = registry.listPendingSessionDeliveries()[0];
      expect(pending).toMatchObject({ attemptCount: 1, status: "pending", lastError: expect.stringContaining("timeout") });

      await vi.advanceTimersByTimeAsync(callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS[0] - 1);
      expect(routeFetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTicks();

      expect(routeFetch).toHaveBeenCalledTimes(2);
      expect(registry.getSessionDelivery(pending.id)).toMatchObject({ status: "accepted", attemptCount: 2 });
      expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(seenPrompts).toHaveLength(1);
    });
  });

  it("restores the persisted timer without sending early after restart during backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    const engine = makeEngine([]);
    const context = makeContext(engine, new queueModule.SessionQueue());
    const parent = createParent("restart-backoff");
    const child = createCompletedChild(parent.id, "restart-backoff");

    await withFetch(vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof globalThis.fetch, async () => {
      callbacks.notifyParentSession(child, { result: "retry after restart" });
      await vi.advanceTimersByTimeAsync(0);
    });
    const delivery = registry.listPendingSessionDeliveries()[0];
    callbacks.__resetCallbackRetrySweepForTest();

    await withRouteBackedFetch(context, {}, async (routeFetch) => {
      await expect(callbacks.recoverPendingSessionDeliveries()).resolves.toBe(0);
      expect(routeFetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS[0]);
      await vi.runAllTicks();

      expect(routeFetch).toHaveBeenCalledOnce();
      expect(registry.getSessionDelivery(delivery.id)).toMatchObject({ status: "accepted", attemptCount: 2 });
    });
  });

  it("never retries an accepted receipt when its HTTP response is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(30_000));
    const engine = makeEngine([]);
    const context = makeContext(engine, new queueModule.SessionQueue());
    const parent = createParent("accepted-immunity");
    const child = createCompletedChild(parent.id, "accepted-immunity");

    await withRouteBackedFetch(context, { throwAfterAccepted: 1 }, async (routeFetch) => {
      callbacks.notifyParentSession(child, { result: "accepted once" });
      await vi.advanceTimersByTimeAsync(0);
      const delivery = dbModule.initDb().prepare(`
        SELECT id FROM callback_deliveries WHERE delivery_kind = 'parent-completion'
      `).get() as { id: string };
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);

      expect(routeFetch).toHaveBeenCalledOnce();
      expect(registry.getSessionDelivery(delivery.id)).toMatchObject({ status: "accepted", attemptCount: 1 });
    });
  });

  it("dead-letters an exhausted receipt and never retries it again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(40_000));
    const parent = createParent("retry-exhaustion");
    const child = createCompletedChild(parent.id, "retry-exhaustion");
    const failingFetch = vi.fn().mockRejectedValue(new Error("permanent outage"));

    await withFetch(failingFetch as unknown as typeof globalThis.fetch, async () => {
      callbacks.notifyParentSession(child, { result: "eventually dead letter" });
      await vi.advanceTimersByTimeAsync(0);
      for (const delay of callbacks.CALLBACK_DELIVERY_RETRY_DELAYS_MS) {
        await vi.advanceTimersByTimeAsync(delay);
        await vi.runAllTicks();
      }
      const delivery = dbModule.initDb().prepare(`SELECT id FROM callback_deliveries`).get() as { id: string };
      expect(registry.getSessionDelivery(delivery.id)).toMatchObject({
        status: "dead_letter",
        attemptCount: callbacks.CALLBACK_DELIVERY_MAX_ATTEMPTS,
        deadLetteredAt: expect.any(Number),
      });
      const attemptsAtExhaustion = failingFetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(failingFetch).toHaveBeenCalledTimes(attemptsAtExhaustion);
    });
  });
});
