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
