import { describe, expect, it } from "vitest";
import { useContextMeterHarness } from "./session-context-api-harness.js";

/** Two ways round a durable stop that are closed: compacting a stopped session,
 *  and a replay withdrawing a deliberate send accepted before its turn began. */
const h = useContextMeterHarness();

describe("the context meter's compact on a stopped session", () => {
  it("is refused with 409 and starts nothing, so the session stays stopped to everyone else", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const usage = await h.request("GET", `/api/sessions/${session.id}/context-usage`);
    expect(usage.body.compact).toMatchObject({ available: false, reason: { code: "stopped" } });
    const compact = await h.request("POST", `/api/sessions/${session.id}/compact`);
    expect(compact.status).toBe(409);
    expect(compact.body).toMatchObject({ code: "stopped" });
    expect(compact.body.error).toMatch(/stopped/);

    expect(h.loopbacks()).toEqual([]);
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.selfCompactionAt(session.id)).toBeUndefined();
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ status: "interrupted", stopped: true });
    const stranger = h.newSession("claude");
    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } });
    expect(sent.status).toBe(409);
  });

  it("is refused for a session stopped while idle as well", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect((await h.request("POST", `/api/sessions/${session.id}/compact`)).status).toBe(409);
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ status: "idle", stopped: true });
  });
});

describe("a deliberate send to a session stopped while idle", () => {
  /** A replay while the accepted turn is still held, as a config reload does. */
  async function replayWhileHeld() {
    const { resumePendingWebQueueItems } = await import("../api.js");
    resumePendingWebQueueItems(h.apiCtx);
  }

  it("ends the stop when the operator's message is accepted, so a replay before its turn keeps the message", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { message: "pick it up again" } });
    expect(sent.status).toBe(200);
    // The queue stub never runs the turn: it is held, and the session is still idle.
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "idle" });
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ stopped: false });

    await replayWhileHeld();
    expect(h.pendingPrompts(session.id)).toEqual(["pick it up again"]);
    expect(h.registry.getMessages(session.id).map((m) => m.content)).toContain("pick it up again");
  });

  it("ends it for an ancestor's message too", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: h.asSession(parent.id) });

    const sent = await h.request("POST", `/api/sessions/${child.id}/message`, {
      headers: h.asSession(parent.id), body: { message: "try again, differently" },
    });
    expect(sent.status).toBe(200);
    await replayWhileHeld();
    expect(h.pendingPrompts(child.id)).toHaveLength(1);
    expect(h.pendingPrompts(child.id)[0]).toContain("try again, differently");
  });

  it("does not end it for a sender it refuses, or for a send that fails validation", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const stranger = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } })).status).toBe(409);
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { body: { role: "notification", from: "a colleague", message: "ping" } })).status).toBe(409);
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { body: { message: "x", delivery: "sideways" } })).status).toBe(400);
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ stopped: true });
  });
});

describe("a compaction turn on its way when the session is stopped", () => {
  const stopped = async (id: string) => (await h.request("GET", `/api/sessions/${id}`)).body.stopped;

  it("does not lift the stop when it reaches the message route in the compaction loopback's shape", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, {
      body: { role: "notification", message: "/compact", displayMessage: "Compacting context" },
    });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ status: "not_delivered" });
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(await stopped(session.id)).toBe(true);
  });

  it("is refused for the context meter's compact when the stop lands after the availability check", async () => {
    const session = h.newSession("claude");
    h.setBeforeLoopback(async () => { await h.request("POST", `/api/sessions/${session.id}/stop`); });

    const compact = await h.request("POST", `/api/sessions/${session.id}/compact`);
    expect(h.loopbacks()).toHaveLength(1);
    expect(compact.status).toBe(409);
    expect(compact.body).toMatchObject({ code: "stopped" });
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.selfCompactionAt(session.id)).toBeUndefined();
    expect(await stopped(session.id)).toBe(true);
  });

  const HANDOFF = { goal: "finish the report", done: "drafted it", next: "proofread it", context: "none", waitingOn: "nothing" };

  it("gives the claim back and promises no resume when the stop lands between the compaction turn and the resume", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    // The 2nd loopback is the resume turn leaving; the compaction turn was accepted by then.
    h.setBeforeLoopback(async () => {
      if (h.loopbacks().length === 2) await h.request("POST", `/api/sessions/${session.id}/stop`);
    });

    const res = await h.request("POST", "/api/compactions", { headers: h.asSession(session.id), body: HANDOFF });
    expect(h.loopbacks()).toHaveLength(2);
    // Not a 202 that says the resume is still on its way: it was refused for good.
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "stopped" });
    expect(res.body.resume).toBeUndefined();
    expect(await stopped(session.id)).toBe(true);
    // The stop withdrew the compaction row; the claim it was made under goes with it.
    expect(h.selfCompactionAt(session.id)).toBeUndefined();

    // The operator starts the session again with a deliberate message and compacts it.
    h.finishQueue(session.id);
    h.registry.updateSession(session.id, { status: "idle" });
    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { message: "carry on" } });
    expect(sent.status).toBe(200);
    expect(await stopped(session.id)).toBe(false);
    h.finishQueue(session.id);
    const compact = await h.request("POST", `/api/sessions/${session.id}/compact`);
    expect(compact.status).toBe(202);
  });

  it("undoes the parent-callback suppression it set when the stop lands between the compaction turn and the resume", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    const attempt = "attempt-asking-turn";
    h.registry.updateSession(child.id, { status: "running", attemptToken: attempt });
    let markerAsResumeLeft: unknown;
    h.setBeforeLoopback(async () => {
      if (h.loopbacks().length !== 2) return;
      markerAsResumeLeft = h.registry.getSession(child.id)!.transportMeta?.reportedToParentAttempt;
      await h.request("POST", `/api/sessions/${child.id}/stop`);
    });

    const res = await h.request("POST", "/api/compactions", { headers: h.asSession(child.id), body: HANDOFF });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "stopped" });
    // It was set for the stopgap turn, and nothing was scheduled after all.
    expect(markerAsResumeLeft).toBe(attempt);
    expect(h.registry.getSession(child.id)!.transportMeta?.reportedToParentAttempt).toBeUndefined();
  });

  it("leaves a send_to_session relay's suppression standing when the stop lands before the resume", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    const attempt = "attempt-asking-turn";
    h.registry.updateSession(child.id, { status: "running", attemptToken: attempt });
    // The child already reported up during this attempt.
    h.registry.recordChildReportedToParent(child.id, attempt);
    h.setBeforeLoopback(async () => {
      if (h.loopbacks().length === 2) await h.request("POST", `/api/sessions/${child.id}/stop`);
    });

    const res = await h.request("POST", "/api/compactions", { headers: h.asSession(child.id), body: HANDOFF });
    expect(res.status).toBe(409);
    expect(h.registry.getSession(child.id)!.transportMeta?.reportedToParentAttempt).toBe(attempt);
  });

  it("gives the claim back when a resume already in the outbox is dead-lettered by a later stop", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    // The resume cannot be delivered the first time (the gateway answers 503), so it waits in the outbox.
    h.setBeforeLoopback(() => { if (h.loopbacks().length === 1) h.setFailLoopback(true); });
    const res = await h.request("POST", "/api/compactions", { headers: h.asSession(session.id), body: HANDOFF });
    h.setFailLoopback(false);
    h.setBeforeLoopback(undefined);
    expect(res.status).toBe(202);
    expect(res.body.resume).toBe("retrying");
    expect(h.selfCompactionAt(session.id)).toBeDefined();

    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const { deliverClaimedSessionDelivery } = await import("../../sessions/callbacks.js");
    const delivery = h.db.initDb().prepare("SELECT id FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = 'self-compaction-resume'")
      .get(session.id) as { id: string };
    // The retry comes due.
    h.db.initDb().prepare("UPDATE callback_deliveries SET next_attempt_at = last_attempt_at WHERE id = ?").run(delivery.id);
    await deliverClaimedSessionDelivery(delivery.id);

    expect(h.registry.getSessionDelivery(delivery.id)?.status).toBe("dead_letter");
    expect(h.selfCompactionAt(session.id)).toBeUndefined();
  });

  it("is refused for compact_session from a session already stopped, which stays stopped", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const res = await h.request("POST", "/api/compactions", { headers: h.asSession(session.id), body: HANDOFF });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "stopped" });
    expect(h.loopbacks()).toEqual([]);
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.selfCompactionAt(session.id)).toBeUndefined();
    expect(await stopped(session.id)).toBe(true);
  });

  it("is refused for compact_session when the stop lands while its compaction turn is on its way, and no resume follows", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    h.setBeforeLoopback(async () => { await h.request("POST", `/api/sessions/${session.id}/stop`); });

    const res = await h.request("POST", "/api/compactions", { headers: h.asSession(session.id), body: HANDOFF });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "stopped" });
    expect(h.loopbacks()).toHaveLength(1);
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.selfCompactionAt(session.id)).toBeUndefined();
    expect(await stopped(session.id)).toBe(true);
  });
});
