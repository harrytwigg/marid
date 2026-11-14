import { describe, expect, it } from "vitest";
import { TALK_ACTION_LOG_LIMIT, TALK_SESSION_TTL_MS, TalkSessionError, TalkSessionRegistry } from "../registry.js";
import { allTools } from "../tools.js";

/** An injected clock, so the reaper is tested against elapsed time rather than
 *  against how long the test suite is willing to sleep. */
function clockAt(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

function openOne(registry: TalkSessionRegistry) {
  return registry.open({ sessionId: "row-1", model: "gpt-realtime-2.1", brief: "", tokenExpiresAt: 1_700_000_600 });
}

describe("TalkSessionRegistry lifecycle", () => {
  it("opens live with the authoritative universal tool manifest", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    expect(session.state).toBe("live");
    expect(session.exposedTools).toEqual(allTools().map((tool) => tool.name));
  });

  it("survives repeated reads without being bound to anything", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    registry.appendTurn(session.id, "how are the todos looking");
    for (let i = 0; i < 3; i += 1) {
      const seen = registry.get(session.id);
      expect(seen?.id).toBe(session.id);
      expect(seen?.state).toBe("live");
      expect(seen?.turns).toHaveLength(1);
    }
  });

  it("moves live to parked and back", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    expect(registry.park(session.id).state).toBe("parked");
    expect(registry.resume(session.id).state).toBe("live");
  });

  it("rejects a park on a parked session and a resume on a live one with 409", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    expect(() => registry.resume(session.id)).toThrow(TalkSessionError);
    expect(() => registry.resume(session.id)).toThrow(/already live/i);
    registry.park(session.id);
    try {
      registry.park(session.id);
      expect.unreachable("park on a parked session must throw");
    } catch (error) {
      expect((error as TalkSessionError).status).toBe(409);
    }
  });

  it("reports an unknown id as 404 rather than inventing a session", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    expect(registry.get("nope")).toBeUndefined();
    try {
      registry.park("nope");
      expect.unreachable("park on an unknown id must throw");
    } catch (error) {
      expect((error as TalkSessionError).status).toBe(404);
    }
  });

  it("closes idempotently", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    registry.close(session.id);
    registry.close(session.id);
    expect(registry.get(session.id)).toBeUndefined();
  });
});

describe("TalkSessionRegistry reaper", () => {
  it("parks a live session that stopped heartbeating and spares one that did not", () => {
    const clock = clockAt();
    const registry = new TalkSessionRegistry(clock.now);
    const abandoned = registry.open({ sessionId: "row-abandoned", model: "gpt-realtime-2.1", brief: "", tokenExpiresAt: 1_700_000_600 });
    const alive = registry.open({ sessionId: "row-alive", model: "gpt-realtime-2.1", brief: "", tokenExpiresAt: 1_700_000_600 });

    clock.advance(TALK_SESSION_TTL_MS / 2);
    registry.heartbeat(alive.id);
    clock.advance(TALK_SESSION_TTL_MS / 2 + 1);
    registry.heartbeat(alive.id);

    expect(registry.reap()).toEqual([abandoned.id]);
    expect(registry.get(abandoned.id)?.state).toBe("parked");
    expect(registry.get(alive.id)?.state).toBe("live");
  });

  it("does not reap a parked session, however long it remains parked", () => {
    const clock = clockAt();
    const registry = new TalkSessionRegistry(clock.now);
    const session = openOne(registry);
    registry.park(session.id);
    clock.advance(TALK_SESSION_TTL_MS + 1);
    expect(registry.reap()).toEqual([]);
    expect(registry.get(session.id)?.state).toBe("parked");
  });
});

describe("TalkSessionRegistry turns", () => {
  it("truncates oldest-first, counts what it dropped, and keeps the newest turn", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    // 400 tokens per turn against a 1000-token budget: the third turn evicts the first.
    const turn = "x".repeat(1600);

    expect(registry.appendTurn(session.id, turn, 1000).truncatedTurns).toBe(0);
    expect(registry.appendTurn(session.id, turn, 1000).truncatedTurns).toBe(0);
    const third = registry.appendTurn(session.id, `${turn}!`, 1000);

    expect(third.truncatedTurns).toBe(1);
    const kept = registry.get(session.id)!.turns;
    expect(kept).toHaveLength(2);
    expect(kept.at(-1)!.text).toBe(`${turn}!`);
  });

  it("always keeps the newest turn even when it alone exceeds the budget", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    const result = registry.appendTurn(session.id, "x".repeat(40_000), 1000);
    expect(registry.get(session.id)!.turns).toHaveLength(1);
    expect(result.handoffSuggested).toBe(true);
  });

  it("refuses turns on a closed session", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    registry.close(session.id);
    expect(() => registry.appendTurn(session.id, "hello")).toThrow(TalkSessionError);
  });
});

describe("TalkSessionRegistry action log", () => {
  function record(registry: TalkSessionRegistry, id: string, subject: string) {
    return registry.recordAction(id, { tool: "label_work_item", subject, lane: "fast", consent: "not-required" });
  }

  it("stamps each entry and appends in the order the writes were attempted", () => {
    const clock = clockAt();
    const registry = new TalkSessionRegistry(clock.now);
    const session = openOne(registry);

    const first = record(registry, session.id, "ABC-1");
    clock.advance(5);
    const second = record(registry, session.id, "ABC-2");

    expect(first.id).not.toBe(second.id);
    expect(second.at - first.at).toBe(5);
    expect(registry.get(session.id)!.actions.map((action) => action.subject)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("drops the oldest once the log is full, keeping the newest entries", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    for (let i = 0; i < TALK_ACTION_LOG_LIMIT + 2; i += 1) record(registry, session.id, `ABC-${i}`);

    const kept = registry.get(session.id)!.actions;
    expect(kept).toHaveLength(TALK_ACTION_LOG_LIMIT);
    expect(kept[0]!.subject).toBe("ABC-2");
    expect(kept.at(-1)!.subject).toBe(`ABC-${TALK_ACTION_LOG_LIMIT + 1}`);
  });
});
