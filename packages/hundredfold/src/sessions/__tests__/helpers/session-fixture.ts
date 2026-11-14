import type { Session } from "../../../shared/types.js";

/**
 * A session row for tests that drive session code without a database. Defaults
 * describe a live Claude turn; every field is overridable, so a case that cares
 * about one of them names only that one.
 */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: "claude-thread-1",
    source: "web",
    sourceRef: "web:test",
    connector: null,
    sessionKey: "k",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: "opus",
    title: null,
    parentSessionId: null,
    status: "running",
    attemptToken: "attempt-1",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    ...overrides,
  } as Session;
}
