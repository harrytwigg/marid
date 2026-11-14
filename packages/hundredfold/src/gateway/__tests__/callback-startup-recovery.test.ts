import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptWithoutExecuting,
  api,
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
import { makeResponse, withFetch, withRouteBackedFetch } from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

describe("callback state recovery at startup", () => {
  it("recovers a pending completion nudge before scanning orphan guards at startup", async () => {
    const context = makeContext(makeEngine([]), acceptWithoutExecuting());
    const parent = createParent("startup-nudge-order");
    const item = workItems.createWorkItem({
      title: "Recover a pending continuation",
      status: "executing",
      source: "delegation",
    });
    const child = createChild(parent.id, "startup-nudge-child", {
      transportMeta: { delegationCompletionTracked: true },
      prompt: "continue after startup",
    });
    workItems.linkSession(item.id, child.id);
    const idle = completeChildAttempt(child.id);
    registry.claimDelegationCompletionNudge(idle.id, item.id);
    registry.claimSessionDelivery({
      targetSessionId: idle.id,

      sourceKind: "session",
      sourceId: idle.id,
      sourceAttempt: idle.attemptToken!,
      sourceOutcome: "succeeded",
      sourceVersion: idle.attemptTerminalVersion!,
      deliveryKind: "delegation-completion-nudge",
      payload: { message: "continue existing task", displayMessage: "continuing task" },
    });

    const orphanParent = createParent("startup-unrelated-orphan");
    const orphanItem = workItems.createWorkItem({
      title: "Surface an unrelated orphan",
      status: "executing",
      source: "delegation",
    });
    const orphan = createChild(orphanParent.id, "startup-unrelated-orphan", {
      employee: undefined,
      transportMeta: { delegationCompletionTracked: true },
      prompt: "orphaned continuation",
    });
    workItems.linkSession(orphanItem.id, orphan.id);
    completeChildAttempt(orphan.id);
    registry.claimDelegationCompletionNudge(orphan.id, orphanItem.id);

    // Holding the nudge request open proves the orphan scan waits behind it
    // rather than racing ahead and surfacing a continuation twice.
    const requestPaths: string[] = [];
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => { releasePending = resolve; });
    const gatedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requestPaths.push(target.pathname);
      if (target.pathname === `/api/sessions/${child.id}/message`) await pendingGate;
      const req = Object.assign(Readable.from([Buffer.from(String(init?.body ?? ""))]), {
        method: init?.method ?? "GET",
        url: `${target.pathname}${target.search}`,
        headers: {
          host: "gateway.test",
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
      });
      const captured = makeResponse();
      await api.handleApiRequest(req as never, captured.res, context);
      return { ok: true, status: captured.status } as Response;
    });

    await withFetch(gatedFetch as unknown as typeof globalThis.fetch, async () => {
      const recovery = callbacks.recoverSessionDeliveryStateOnStartup();
      await eventually(() => expect(requestPaths).toHaveLength(1));
      expect(requestPaths[0]).toBe(`/api/sessions/${child.id}/message`);
      releasePending();
      await expect(recovery).resolves.toEqual({
        pendingRecovered: 1,
        orphanedRecovered: 1,
      });
      expect(registry.getMessages(child.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(registry.getMessages(parent.id)).toEqual([]);
      expect(registry.getMessages(orphanParent.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(registry.getSession(child.id)?.transportMeta).toMatchObject({
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      });
    });
  });

  it("quarantines a poison row and still recovers the following valid receipt across restart", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const context = makeContext(makeEngine(seenPrompts), new queueModule.SessionQueue(), events);
    const parent = createParent("poison-restart");
    const child = createChild(parent.id, "poison-restart-child", {
      employee: undefined,
      prompt: "finish after poison",
    });
    const database = dbModule.initDb();
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO callback_deliveries (
        id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
        source_version, delivery_kind, payload, status, created_at
      ) VALUES ('poison-before-valid', ?, 'session', ?, 'poison-attempt', 'failed', 1,
        'parent-completion', '{bad json', 'pending', '2026-01-01T00:00:00.000Z')
    `).run(parent.id, child.id);
    database.pragma("ignore_check_constraints = OFF");
    const valid = registry.claimSessionDelivery({
      targetSessionId: parent.id,

      sourceKind: "session",
      sourceId: child.id,
      sourceAttempt: "valid-attempt",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "valid after poison", displayMessage: "valid after poison" },
    }).delivery;

    await withRouteBackedFetch(context, {}, async (routeFetch) => {
      await expect(callbacks.recoverSessionDeliveryStateOnStartup()).resolves.toEqual({
        pendingRecovered: 1,
        orphanedRecovered: 0,
      });
      await eventually(() => expect(seenPrompts).toEqual(["valid after poison"]));
      await expect(callbacks.recoverSessionDeliveryStateOnStartup()).resolves.toEqual({
        pendingRecovered: 0,
        orphanedRecovered: 0,
      });
      expect(registry.getSessionDelivery(valid.id)).toMatchObject({ status: "accepted" });
      expect(database.prepare(`
        SELECT status, last_error AS lastError FROM callback_deliveries WHERE id = 'poison-before-valid'
      `).get()).toMatchObject({ status: "dead_letter", lastError: expect.stringMatching(/invalid payload json/i) });
      expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
      expect(routeFetch).toHaveBeenCalledOnce();
    });
  });
});
