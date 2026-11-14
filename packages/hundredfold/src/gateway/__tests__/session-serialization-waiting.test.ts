import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import { serializeSession, type ApiContext } from "../api.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:sess-1",
    connector: "web",
    sessionKey: "web:sess-1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null, fallbackMode: null, fallbackTarget: null, claudeConfigDir: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    lastActivity: "2026-06-01T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function makeContext(
  backgroundActivity?: ApiContext["backgroundActivity"],
  transportByKey: Record<string, "idle" | "queued" | "running" | "error" | "interrupted"> = {},
  engine?: unknown,
): ApiContext {
  return {
    backgroundActivity,
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
        getTransportState: (key: string) => transportByKey[key] ?? "idle",
      }),
      getEngine: () => engine,
    },
  } as unknown as ApiContext;
}

describe("serializeSession: a session paused on a usage limit", () => {
  it("exposes a session paused on a usage limit as waiting, with the reason, never as running or error", () => {
    const session = makeSession({
      status: "waiting",
      lastError: "Claude usage limit — resumes 2026-06-01T06:00:00.000Z",
    });
    // The wait holds the session's queue slot, so the queue reports it running.
    const serialized = serializeSession(session, makeContext(undefined, { "web:sess-1": "running" }));

    expect(serialized.status).toBe("waiting");
    expect(serialized.lastError).toBe("Claude usage limit — resumes 2026-06-01T06:00:00.000Z");
    expect(serialized.turnProgress).toBeNull();
  });

  it("keeps a waiting session waiting while background work of its own is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const context = makeContext(new Map([["sess-1", { activeStreams: 1, lastActivityAt: Date.now() }]]));

    expect(serializeSession(makeSession({ status: "waiting" }), context).status).toBe("waiting");
    vi.useRealTimers();
  });
});
