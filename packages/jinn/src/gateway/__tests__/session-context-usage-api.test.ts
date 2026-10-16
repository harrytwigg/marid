import { describe, expect, it } from "vitest";
import { useContextMeterHarness } from "./session-context-api-harness.js";

/** `GET /api/sessions/:id/context-usage` against the real gateway API and registry. */
const h = useContextMeterHarness();

describe("GET /api/sessions/:id/context-usage", () => {
  it("reports the size, the model's window, the policy and that a compaction is available", async () => {
    const s = h.newSession("claude");
    h.registry.updateSession(s.id, { model: "opus", lastContextTokens: 123_456 });
    h.setEngineConfig({ claude: { autoCompact: { enabled: true, maxContextTokens: 150_000 } } });
    const res = await h.request("GET", `/api/sessions/${s.id}/context-usage`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: s.id,
      engine: "claude",
      model: "opus",
      modelLabel: "Opus (Latest)",
      contextTokens: 123_456,
      contextWindow: 200_000,
      autoCompact: { enabled: true, budgetTokens: 150_000 },
      compact: { available: true },
    });
  });

  it("uses the engine's default model, and nulls for what is unknown", async () => {
    const fresh = h.newSession("claude", { conversation: false });
    const res = await h.request("GET", `/api/sessions/${fresh.id}/context-usage`);
    expect(res.body).toMatchObject({
      model: "opus", modelLabel: "Opus (Latest)", contextTokens: null, contextWindow: 200_000,
      autoCompact: { enabled: false, budgetTokens: null },
      compact: { available: false, reason: { code: "no-conversation" } },
    });

    const noWindow = h.newSession("claude");
    h.registry.updateSession(noWindow.id, { model: "sonnet" });
    expect((await h.request("GET", `/api/sessions/${noWindow.id}/context-usage`)).body).toMatchObject({ model: "sonnet", contextWindow: null });
  });

  it("reads a [1m] model as 1,000,000", async () => {
    const s = h.newSession("claude");
    h.registry.updateSession(s.id, { model: "opus[1m]" });
    expect((await h.request("GET", `/api/sessions/${s.id}/context-usage`)).body).toMatchObject({ model: "opus[1m]", contextWindow: 1_000_000 });
  });

  it("says unsupported (with a null policy) for an engine that cannot compact", async () => {
    const s = h.newSession("codex");
    const body = (await h.request("GET", `/api/sessions/${s.id}/context-usage`)).body;
    expect(body).toMatchObject({ engine: "codex", autoCompact: { enabled: false, budgetTokens: null }, compact: { available: false, reason: { code: "unsupported" } } });
    expect(body.compact.retryAt).toBeUndefined();
  });

  it("reports a refusal for a terminal session", async () => {
    const s = h.newSession("terminal", { source: "terminal" });
    expect((await h.request("GET", `/api/sessions/${s.id}/context-usage`)).body.compact.reason.code).toBe("terminal");
  });

  it("reports busy while a turn runs, queued behind it, and compacting for a compaction turn or an auto-compaction", async () => {
    const s = h.newSession("claude");
    h.registry.updateSession(s.id, { status: "running" } as never);
    const compactOf = async () => (await h.request("GET", `/api/sessions/${s.id}/context-usage`)).body.compact.reason.code;
    expect(await compactOf()).toBe("busy");

    const itemId = h.queueItems.enqueueQueueItem(s.id, s.sessionKey, "/compact");
    h.queueItems.markQueueItemRunning(itemId);
    expect(await compactOf()).toBe("compacting");
    h.queueItems.markQueueItemCompleted(itemId);
    expect(await compactOf()).toBe("busy");

    h.registry.updateSession(s.id, { status: "idle" } as never);
    h.queueItems.enqueueQueueItem(s.id, s.sessionKey, "hello");
    expect(await compactOf()).toBe("queued");

    const other = h.newSession("claude");
    h.autoCompaction.markAutoCompacting(other.id, true);
    try {
      expect((await h.request("GET", `/api/sessions/${other.id}/context-usage`)).body.compact.reason.code).toBe("compacting");
    } finally {
      h.autoCompaction.markAutoCompacting(other.id, false);
    }
  });

  it("reports the cooldown with retryAt, and never claims it", async () => {
    const s = h.newSession("claude");
    expect(h.selfCompactionAt(s.id)).toBeUndefined();
    await h.request("GET", `/api/sessions/${s.id}/context-usage`);
    await h.request("GET", `/api/sessions/${s.id}/context-usage`);
    expect(h.selfCompactionAt(s.id)).toBeUndefined();

    const claimedAt = Date.now() - 120_000;
    h.registry.claimSelfCompaction(s.id, claimedAt, 600_000);
    const body = (await h.request("GET", `/api/sessions/${s.id}/context-usage`)).body;
    expect(body.compact).toMatchObject({ available: false, reason: { code: "cooldown" }, retryAt: new Date(claimedAt + 600_000).toISOString() });
    expect(h.selfCompactionAt(s.id)).toBe(claimedAt);
  });

  it("answers 404 for an unknown session", async () => {
    const res = await h.request("GET", "/api/sessions/no-such-session/context-usage");
    expect(res.status).toBe(404);
  });
});

