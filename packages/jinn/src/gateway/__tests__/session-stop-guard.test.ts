import { describe, expect, it } from "vitest";
import { useContextMeterHarness } from "./session-context-api-harness.js";

/** `POST /api/sessions/:id/stop` and the meter's compact route share one reach guard. */
const h = useContextMeterHarness();

describe("POST /api/sessions/:id/stop reach", () => {
  it("is open to the operator and to the spawning session, and says what an agent may stop otherwise", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    const stranger = h.newSession("claude");

    const unidentified = await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: { "x-jinn-tool-call": "jinn-mcp" } });
    expect(unidentified.status).toBe(403);

    const lateral = await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: h.asSession(stranger.id) });
    expect(lateral.status).toBe(403);
    expect(lateral.body.error).toBe(
      `session ${child.id} is not a descendant of your session — agents may only stop sessions they spawned (directly or transitively) or delegated to. Ask the operator or the session's parent instead.`,
    );

    expect((await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: h.asSession(parent.id) })).body).toMatchObject({ status: "stopped" });
    expect((await h.request("POST", `/api/sessions/${child.id}/stop`)).body).toMatchObject({ status: "stopped" });
  });
});
