import { describe, expect, it } from "vitest";
import type { Engine, EngineRunOpts, JinnConfig, Session, StreamDelta } from "../../shared/types.js";
import { useContextMeterHarness } from "./session-context-api-harness.js";

/** `POST /api/sessions/:id/compact` against the real gateway API, registry and queue rows. */
const h = useContextMeterHarness();

describe("POST /api/sessions/:id/compact", () => {
  it("queues the bare /compact turn through the message route, with the meter's display text, and claims the cooldown", async () => {
    const s = h.newSession("claude");
    const res = await h.request("POST", `/api/sessions/${s.id}/compact`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "queued", sessionId: s.id, engine: "claude" });

    expect(h.loopbacks()).toEqual([{
      path: `/api/sessions/${s.id}/message`,
      body: { message: "/compact", role: "notification", displayMessage: "🗜️ Compacting context — requested from the context meter" },
    }]);
    expect(h.pendingPrompts(s.id)).toEqual(["/compact"]);
    expect(h.registry.getMessages(s.id).map((m) => `${m.role}: ${m.content}`)).toEqual(["notification: 🗜️ Compacting context — requested from the context meter"]);
    expect(typeof h.selfCompactionAt(s.id)).toBe("number");
  });

  it("queues a turn that really is a compaction: the engine gets /compact, the chat says so, and the size is settled", async () => {
    const { runTurn } = await import("../../sessions/turn/runner.js");
    const { createWebTurnSurface } = await import("../web-turn-surface.js");
    const s = h.newSession("claude");
    h.registry.updateSession(s.id, { lastContextTokens: 531_000 });
    expect((await h.request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);

    const deltas: StreamDelta[] = [];
    const prompts: string[] = [];
    const engine: Engine = {
      name: "claude",
      async run(opts: EngineRunOpts) {
        prompts.push(opts.prompt);
        return { sessionId: `claude-thread-${s.id}`, result: "", compaction: { preTokens: 531_000, postTokens: 8_800 }, contextTokens: 8_800 };
      },
    };
    const surface = createWebTurnSurface({
      sessionId: s.id,
      emit: ((event: string, payload: { type?: string; content?: string }) => {
        if (event === "session:delta" && payload.type === "status") deltas.push({ type: "status", content: payload.content ?? "" });
      }) as never,
      connectors: new Map(),
      getConfig: () => ({}) as JinnConfig,
    });
    const started = h.registry.beginSessionAttempt(s.id)!;
    await runTurn({
      session: h.registry.getSession(s.id)!,
      attemptToken: started.attemptToken!,
      prompt: h.pendingPrompts(s.id)[0]!,
      attachments: [],
      config: h.apiCtx.getConfig() as unknown as JinnConfig,
      engines: new Map([["claude", engine]]),
      gatewayBootId: "test-boot",
      connectorNames: [],
      channel: "web",
      user: "operator",
    }, surface);

    expect(prompts).toEqual(["/compact"]);
    expect(deltas.map((d) => d.content)).toContain("🗜️ Compacting context…");
    expect(h.registry.getMessages(s.id).map((m) => m.content)).toContain("🗜️ Context compacted: 531k tokens → 8.8k tokens.");
    expect(h.registry.getSession(s.id)!.lastContextTokens).toBe(8_800);
  });

  it("refuses a second request while the first is still queued, then inside the cooldown with 429 and when it ends", async () => {
    const s = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);
    // Queued comes before the cooldown in the order of checks.
    expect((await h.request("POST", `/api/sessions/${s.id}/compact`)).body).toMatchObject({ code: "queued" });
    h.finishQueue(s.id);
    const again = await h.request("POST", `/api/sessions/${s.id}/compact`);
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "cooldown", error: expect.any(String) });
    expect(Date.parse(again.body.retryAt)).toBe(h.selfCompactionAt(s.id) as number + 600_000);
    expect(h.loopbacks()).toHaveLength(1);
  });

  it("shares the cooldown with a self-requested compaction", async () => {
    const s = h.newSession("claude");
    h.registry.claimSelfCompaction(s.id, Date.now(), 600_000);
    const res = await h.request("POST", `/api/sessions/${s.id}/compact`);
    expect(res.status).toBe(429);
    expect(h.loopbacks()).toEqual([]);
  });

  it("answers each refusal with 409 and its code, and claims nothing", async () => {
    const cases: Array<[string, () => Session]> = [
      ["terminal", () => h.newSession("terminal", { source: "terminal" })],
      ["unsupported", () => h.newSession("codex")],
      ["no-conversation", () => h.newSession("claude", { conversation: false })],
      ["busy", () => {
        const s = h.newSession("claude");
        h.registry.updateSession(s.id, { status: "running" } as never);
        return s;
      }],
      ["queued", () => {
        const s = h.newSession("claude");
        h.queueItems.enqueueQueueItem(s.id, s.sessionKey, "hello");
        return s;
      }],
    ];
    for (const [expected, make] of cases) {
      const s = make();
      const res = await h.request("POST", `/api/sessions/${s.id}/compact`);
      expect(res.status, expected).toBe(409);
      expect(res.body, expected).toMatchObject({ code: expected, error: expect.any(String) });
      expect(h.selfCompactionAt(s.id), expected).toBeUndefined();
    }
    const running = h.newSession("claude");
    h.registry.updateSession(running.id, { status: "running" } as never);
    const itemId = h.queueItems.enqueueQueueItem(running.id, running.sessionKey, "/compact keep the plan");
    h.queueItems.markQueueItemRunning(itemId);
    expect((await h.request("POST", `/api/sessions/${running.id}/compact`)).body).toMatchObject({ code: "compacting" });
    expect(h.loopbacks()).toEqual([]);
  });

  it("refuses opencode in run mode and accepts it in server mode", async () => {
    const s = h.newSession("opencode");
    h.setOpencodeMode("run");
    expect((await h.request("POST", `/api/sessions/${s.id}/compact`)).body).toMatchObject({ code: "unsupported", error: expect.stringMatching(/server mode/) });
    h.setOpencodeMode("server");
    expect((await h.request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);
    expect(h.pendingPrompts(s.id)).toEqual(["/compact"]);
  });

  it("answers 502 and gives the claim back when the turn cannot be queued, so the meter can retry at once", async () => {
    const s = h.newSession("claude");
    h.setFailLoopback(true);
    const res = await h.request("POST", `/api/sessions/${s.id}/compact`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Nothing was queued: .*simulated/);
    expect(h.selfCompactionAt(s.id)).toBeUndefined();
    expect((await h.request("GET", `/api/sessions/${s.id}/context-usage`)).body.compact).toEqual({ available: true });

    h.setFailLoopback(false);
    expect((await h.request("POST", `/api/sessions/${s.id}/compact`)).status).toBe(202);
  });

  it("answers 404 for an unknown session", async () => {
    expect((await h.request("POST", "/api/sessions/no-such-session/compact")).status).toBe(404);
  });

  it("is open to the operator, to a session that spawned the target and to its delegator, not to others", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    const stranger = h.newSession("claude");

    const unidentified = await h.request("POST", `/api/sessions/${child.id}/compact`, { headers: { "x-jinn-tool-call": "jinn-mcp" } });
    expect(unidentified.status).toBe(403);

    const lateral = await h.request("POST", `/api/sessions/${child.id}/compact`, { headers: h.asSession(stranger.id) });
    expect(lateral.status).toBe(403);
    expect(lateral.body.error).toMatch(/not a descendant of your session/);
    expect(h.selfCompactionAt(child.id)).toBeUndefined();

    const own = await h.request("POST", `/api/sessions/${child.id}/compact`, { headers: h.asSession(parent.id) });
    expect(own.status).toBe(202);

    const operator = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${operator.id}/compact`)).status).toBe(202);
  });
});

