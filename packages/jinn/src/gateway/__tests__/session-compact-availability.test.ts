import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types.js";
import type { AvailabilityDeps } from "../session-context-api.js";
import { useContextMeterHarness } from "./session-context-api-harness.js";

const h = useContextMeterHarness();

describe("compactAvailability", () => {
  const NOW = 1_800_000_000_000;
  const deps = (over: Partial<AvailabilityDeps> = {}): AvailabilityDeps => ({
    opencodeMode: "server",
    now: NOW,
    isAutoCompacting: () => false,
    reportedStatus: (s) => s.status,
    runningTurnIsCompaction: () => false,
    pendingQueueCount: () => 0,
    ...over,
  });
  const session = (over: Record<string, unknown> = {}): Session => ({
    id: "s1", engine: "claude", source: "web", status: "idle", engineSessionId: "thread-1", engineSessions: null, transportMeta: null, ...over,
  }) as unknown as Session;
  const code = (s: Session, d: AvailabilityDeps) => {
    const result = h.availability.compactAvailability(s, d);
    return result.available ? "available" : result.reason.code;
  };

  it("is available for an idle session with a conversation and nothing queued", () => {
    expect(h.availability.compactAvailability(session(), deps())).toEqual({ available: true });
  });

  it("refuses each way, with a short message", () => {
    const messages = {
      terminal: h.availability.compactAvailability(session({ source: "terminal", engine: "terminal" }), deps()),
      unsupported: h.availability.compactAvailability(session({ engine: "codex" }), deps()),
      noConversation: h.availability.compactAvailability(session({ engineSessionId: null }), deps()),
      compacting: h.availability.compactAvailability(session(), deps({ isAutoCompacting: () => true })),
      busy: h.availability.compactAvailability(session({ status: "running" }), deps()),
      queued: h.availability.compactAvailability(session(), deps({ pendingQueueCount: () => 2 })),
    };
    expect(Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, v.available ? "available" : v.reason.code]))).toEqual({
      terminal: "terminal", unsupported: "unsupported", noConversation: "no-conversation", compacting: "compacting", busy: "busy", queued: "queued",
    });
    for (const refused of Object.values(messages)) {
      if (refused.available) throw new Error("expected a refusal");
      expect(refused.reason.message.length).toBeGreaterThan(10);
      expect(refused.reason.message.length).toBeLessThan(260);
      expect(refused.retryAt).toBeUndefined();
    }
    expect(messages.queued.available === false && messages.queued.reason.message).toMatch(/^2 messages are queued/);
  });

  it("names run mode for opencode and no native compaction for other engines", () => {
    const run = h.availability.compactAvailability(session({ engine: "opencode" }), deps({ opencodeMode: "run" }));
    expect(run.available === false && run.reason).toMatchObject({ code: "unsupported", message: expect.stringMatching(/server mode/) });
    const other = h.availability.compactAvailability(session({ engine: "grok" }), deps());
    expect(other.available === false && other.reason).toMatchObject({ code: "unsupported", message: expect.stringMatching(/isn't supported on the grok engine/) });
    expect(code(session({ engine: "opencode", engineSessionId: "x" }), deps({ opencodeMode: "server" }))).toBe("available");
  });

  it("treats a waiting session, and one with live background work, as busy", () => {
    expect(code(session({ status: "waiting" }), deps())).toBe("busy");
    expect(code(session({ status: "idle" }), deps({ reportedStatus: () => "running" }))).toBe("busy");
  });

  it("reads a running compaction turn as compacting, not busy", () => {
    const running = session({ status: "running" });
    expect(code(running, deps({ runningTurnIsCompaction: () => true }))).toBe("compacting");
    // The running turn only counts while a turn is running.
    expect(code(session(), deps({ runningTurnIsCompaction: () => true }))).toBe("available");
  });

  it("refuses by the documented order: terminal, unsupported, no-conversation, compacting, busy, queued, cooldown", () => {
    const everything = deps({ isAutoCompacting: () => true, pendingQueueCount: () => 3 });
    const cooling = { selfCompactionAt: NOW - 1000 };
    const full = (over: Record<string, unknown>) => session({ status: "running", transportMeta: cooling, ...over });

    expect(code(full({ source: "terminal", engine: "terminal", engineSessionId: null }), everything)).toBe("terminal");
    expect(code(full({ engine: "codex", engineSessionId: null }), everything)).toBe("unsupported");
    expect(code(full({ engineSessionId: null }), everything)).toBe("no-conversation");
    expect(code(full({}), everything)).toBe("compacting");
    expect(code(full({}), deps({ pendingQueueCount: () => 3 }))).toBe("busy");
    expect(code(session({ transportMeta: cooling }), deps({ pendingQueueCount: () => 3 }))).toBe("queued");
    expect(code(session({ transportMeta: cooling }), deps())).toBe("cooldown");
  });

  it("reads the cooldown without claiming it, and says when it ends", () => {
    const claimedAt = NOW - 60_000;
    const refused = h.availability.compactAvailability(session({ transportMeta: { selfCompactionAt: claimedAt } }), deps());
    expect(refused).toMatchObject({ available: false, reason: { code: "cooldown" }, retryAt: new Date(claimedAt + 10 * 60_000).toISOString() });
    // At the end of the window it is available again.
    expect(h.availability.compactAvailability(session({ transportMeta: { selfCompactionAt: NOW - 10 * 60_000 } }), deps())).toEqual({ available: true });
    expect(h.availability.compactAvailability(session({ transportMeta: { selfCompactionAt: "garbage" } }), deps())).toEqual({ available: true });
  });
});

