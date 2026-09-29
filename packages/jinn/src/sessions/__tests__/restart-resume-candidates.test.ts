import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-resume-"));
process.env.JINN_HOME = home;

const gatewayConfig: { resumeInterruptedSessions?: boolean } = {};
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: gatewayConfig })),
}));
vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://restart-fixture.invalid" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));

type Registry = typeof import("../registry.js");
type RestartResume = typeof import("../restart-resume.js");
let registry: Registry;
let restartResume: RestartResume;
let db: import("better-sqlite3").Database;
let callbacks: typeof import("../callbacks.js");
const attempts: Promise<unknown>[] = [];
const respond: Array<() => void> = [];

beforeAll(async () => {
  registry = await import("../registry.js");
  restartResume = await import("../restart-resume.js");
  db = (await import("../../shared/db.js")).initDb();
  callbacks = await import("../callbacks.js");
});

beforeEach(() => {
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
  delete gatewayConfig.resumeInterruptedSessions;
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
    respond.push(() => resolve(new Response(null, { status: 204 })));
  })));
  const deliver = callbacks.deliverClaimedSessionDelivery;
  vi.spyOn(callbacks, "deliverClaimedSessionDelivery").mockImplementation((id) => {
    const pending = deliver(id);
    attempts.push(pending);
    return pending;
  });
});

// The nudge API returns its claim before the transport finishes. Releasing the
// fixture first used to leave real HTTP responses logging after worker teardown.
afterEach(async () => {
  respond.splice(0).forEach((resolve) => resolve());
  try {
    const settled = await Promise.allSettled(attempts);
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), "Restart delivery fixture failed");
    }
  } finally {
    attempts.length = 0;
    callbacks.__resetCallbackRetrySweepForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function session(status: string, overrides: Record<string, unknown> = {}) {
  const created = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${status}` });
  db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, created.id);
  if (Object.keys(overrides).length > 0) registry.updateSession(created.id, overrides);
  return registry.getSession(created.id)!;
}

/** The shutdown path only stamps `running` sessions, so the boot side sees a
 *  candidate exactly when the previous process really did cut a turn short. */
function interruptedByRestart() {
  const running = session("running");
  restartResume.interruptRunningSessionsForShutdown(GATEWAY);
  return registry.getSession(running.id)!;
}

const GATEWAY = { bootId: "boot0001", gatewayVersion: "0.31.0" };
const NONE = { resumable: [], replaying: [] };

function resumableIds() {
  return restartResume.consumeRestartResumeCandidates().resumable.map((c) => c.session.id);
}

describe("restart interruption marking", () => {
  it("stamps a session that was running at clean shutdown", () => {
    const marked = interruptedByRestart();

    expect(marked.status).toBe("interrupted");
    expect(marked.transportMeta?.[registry.RESTART_RESUME_META_KEY]).toEqual(expect.any(String));
    expect(resumableIds()).toEqual([marked.id]);
  });

  it("never stamps a session that was already idle, waiting or errored", () => {
    const untouched = ["idle", "waiting", "error"].map((status) => session(status));

    restartResume.interruptRunningSessionsForShutdown(GATEWAY);

    for (const before of untouched) {
      expect(registry.getSession(before.id)?.transportMeta ?? null).toBeNull();
    }
    expect(restartResume.consumeRestartResumeCandidates()).toEqual(NONE);
  });

  it("leaves a restart-requesting session idle and unstamped", () => {
    const requester = session("running", { transportMeta: { [registry.RESTART_ACK_META_KEY]: new Date().toISOString() } });

    restartResume.interruptRunningSessionsForShutdown(GATEWAY);

    expect(registry.getSession(requester.id)?.status).toBe("idle");
    expect(restartResume.consumeRestartResumeCandidates()).toEqual(NONE);
  });

  it("stamps a session the previous gateway never got to shut down cleanly", () => {
    const crashed = session("running");

    expect(registry.recoverStaleSessions()).toBe(1);

    expect(resumableIds()).toEqual([crashed.id]);
  });

  it("never makes a workflow attempt session a candidate, however it was interrupted", () => {
    const attempt = session("running");
    db.prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(attempt.id);

    restartResume.interruptRunningSessionsForShutdown(GATEWAY);
    registry.recoverStaleSessions();
    // Workflow attempts have their own restart recovery; this is the one that owns them.
    expect(registry.recoverStaleWorkflowAttemptSessions()).toBe(1);

    expect(registry.getSession(attempt.id)?.status).toBe("interrupted");
    expect(restartResume.consumeRestartResumeCandidates()).toEqual(NONE);
  });

  it("holds a workflow attempt out of the candidates even when it carries the mark", () => {
    const attempt = session("running");
    db.prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(attempt.id);
    registry.updateSession(attempt.id, { transportMeta: { [registry.RESTART_RESUME_META_KEY]: new Date().toISOString() } });

    expect(restartResume.consumeRestartResumeCandidates()).toEqual(NONE);
  });
});

describe("consumeRestartResumeCandidates", () => {
  it("hands a session whose pending queue item is already being replayed to the queue, not the nudge", () => {
    const marked = interruptedByRestart();
    registry.enqueueQueueItem(marked.id, marked.sessionKey || marked.id, "resume me");

    expect(registry.listAllPendingQueueItems()).toHaveLength(1);
    const candidates = restartResume.consumeRestartResumeCandidates();
    expect(candidates.resumable).toEqual([]);
    expect(candidates.replaying.map((s) => s.id)).toEqual([marked.id]);
    // Its mark is still consumed, so it cannot resurface on a later restart.
    expect(registry.getSession(marked.id)?.transportMeta ?? null).toBeNull();
  });

  it("returns each candidate once and nothing on a second boot", () => {
    const marked = interruptedByRestart();

    expect(resumableIds()).toEqual([marked.id]);
    expect(restartResume.consumeRestartResumeCandidates()).toEqual(NONE);
  });
});

describe("notifyGatewayRestartResume", () => {
  it("claims exactly one delivery carrying the restart message", () => {
    const marked = interruptedByRestart();

    expect(restartResume.notifyGatewayRestartResume(marked, "0.31.0")).toMatchObject({ claimed: true });

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ targetSessionId: marked.id, deliveryKind: "gateway-restart-resume" });
    expect(deliveries[0].payload.message).toContain("[Gateway] Restart complete (v0.31.0)");
  });

  it("creates no second row when the same nudge is claimed twice", () => {
    const marked = interruptedByRestart();
    const fresh = registry.getSession(marked.id)!;

    expect(restartResume.notifyGatewayRestartResume(fresh, "0.31.0")).toMatchObject({ claimed: true });
    expect(restartResume.notifyGatewayRestartResume(registry.getSession(marked.id)!, "0.31.0")).toEqual({ claimed: false, reason: "already-nudged" });

    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });

  it("persists the nudge as a notification, not as operator input", () => {
    const marked = interruptedByRestart();
    restartResume.notifyGatewayRestartResume(marked, "0.31.0");
    const [delivery] = registry.listPendingSessionDeliveries();

    registry.acceptSessionDelivery(delivery.id, marked.id, marked.sessionKey || marked.id);

    expect(registry.getMessages(marked.id)).toEqual([
      expect.objectContaining({ role: "notification", content: expect.stringContaining("[Gateway] Restart complete") }),
    ]);
  });
});

describe("resumeRestartInterruptedSessions", () => {
  it("nudges the candidates a restart interrupted", () => {
    vi.useFakeTimers();
    const marked = interruptedByRestart();

    restartResume.resumeRestartInterruptedSessions(GATEWAY);
    vi.advanceTimersByTime(0);

    expect(registry.listPendingSessionDeliveries().map((d) => d.targetSessionId)).toEqual([marked.id]);
  });

  it("claims nothing for any candidate when resumeInterruptedSessions is off", () => {
    vi.useFakeTimers();
    interruptedByRestart();
    gatewayConfig.resumeInterruptedSessions = false;

    restartResume.resumeRestartInterruptedSessions(GATEWAY);
    vi.advanceTimersByTime(10 * 60_000);

    expect(registry.listPendingSessionDeliveries()).toEqual([]);
  });
});

/**
 *The session that ran `jinn restart` — directly, or from a detached
 * script it launched — and then ended its turn to wait on a background poll for
 * the result. It is idle when the gateway shuts down, so the running sweep never
 * sees it; before the fix the next boot only posted a passive notice in it and it
 * sat idle until the operator opened it. Each test walks the real sequence: the
 * API's acknowledgement, the old gateway's shutdown, the new gateway's boot.
 */
describe("the session that asked for the restart", () => {
  /** What POST /api/system/restart does to the requesting session. */
  function askForRestart(id: string, at = new Date().toISOString()) {
    const current = registry.getSession(id)!;
    registry.updateSession(id, {
      status: "idle",
      transportMeta: { ...(current.transportMeta ?? {}), [registry.RESTART_ACK_META_KEY]: at },
    });
  }

  function restartAndBoot() {
    restartResume.interruptRunningSessionsForShutdown(GATEWAY);
    restartResume.acknowledgeRestartRequesters(GATEWAY);
    restartResume.resumeRestartInterruptedSessions(GATEWAY);
    // One candidate, so its nudge is due at once; the clock barely moves, as between two real boots.
    vi.advanceTimersByTime(1_000);
  }

  it("nudges an idle requester back after the restart, with the requester's message", () => {
    vi.useFakeTimers();
    const requester = session("idle");
    askForRestart(requester.id);

    restartAndBoot();

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries.map((d) => d.targetSessionId)).toEqual([requester.id]);
    expect(deliveries[0].payload.message).toContain("The restart this session requested is complete");
    expect(deliveries[0].payload.message).toContain("Do not request another restart");
    expect(registry.getMessages(requester.id).map((m) => m.content)).toContain("Gateway restarted successfully.");
    expect(registry.getSession(requester.id)?.transportMeta?.[registry.RESTART_REQUESTER_NUDGES_META_KEY]).toEqual([expect.any(String)]);
  });

  it("nudges a requester whose turn was still running at shutdown too", () => {
    vi.useFakeTimers();
    const requester = session("running");
    askForRestart(requester.id);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(requester.id);

    restartAndBoot();

    expect(registry.getSession(requester.id)?.status).toBe("idle");
    expect(registry.listPendingSessionDeliveries().map((d) => d.targetSessionId)).toEqual([requester.id]);
  });

  it("nudges a redeploy after a failed verify, but not a third restart in a row", () => {
    vi.useFakeTimers();
    const requester = session("idle");
    const nudgesAfterRestart = () => {
      askForRestart(requester.id);
      restartAndBoot();
      const count = registry.listPendingSessionDeliveries().length;
      db.prepare("DELETE FROM callback_deliveries").run();
      vi.advanceTimersByTime(5 * 60_000);
      return count;
    };

    expect(nudgesAfterRestart()).toBe(1);
    expect(nudgesAfterRestart()).toBe(1);
    expect(nudgesAfterRestart()).toBe(0);
    expect(registry.getMessages(requester.id).filter((m) => m.content === "Gateway restarted successfully.")).toHaveLength(3);
  });

  it("leaves a requester to its pending queue item when one will re-drive it", () => {
    vi.useFakeTimers();
    const requester = session("idle");
    askForRestart(requester.id);
    registry.enqueueQueueItem(requester.id, requester.sessionKey || requester.id, "queued follow-up");

    restartAndBoot();

    expect(registry.listPendingSessionDeliveries()).toEqual([]);
  });

  it("treats a running session carrying a stale acknowledgement as interrupted, not as the requester", () => {
    vi.useFakeTimers();
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const running = session("running", { transportMeta: { [registry.RESTART_ACK_META_KEY]: twoHoursAgo } });

    restartAndBoot();

    expect(registry.getSession(running.id)?.status).toBe("interrupted");
    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries.map((d) => d.targetSessionId)).toEqual([running.id]);
    expect(deliveries[0].payload.message).toContain("Your previous turn was interrupted by a gateway restart");
  });

  it("claims one nudge per restart request, however many times it is attempted", () => {
    const requester = session("idle");
    const mark = { reason: "requested" as const, markedAt: "2026-09-22T16:47:47.417Z" };

    expect(restartResume.notifyGatewayRestartResume(requester, "0.33.3", mark)).toMatchObject({ claimed: true });
    expect(restartResume.notifyGatewayRestartResume(requester, "0.33.3", mark)).toEqual({ claimed: false, reason: "already-nudged" });
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });

  it("puts requesters ahead of the cap, however old their conversation", () => {
    const now = Date.now();
    const bystanders = Array.from({ length: restartResume.MAX_RESTART_RESUMES }, (_, i) =>
      ({ session: session("interrupted", { lastActivity: new Date(now - i * 1000).toISOString() }), reason: "interrupted" as const, markedAt: "" }));
    const requester = { session: session("idle", { lastActivity: new Date(now - 86_400_000).toISOString() }), reason: "requested" as const, markedAt: "" };

    const plan = restartResume.planRestartResumes({ candidates: [...bystanders, requester], now });

    expect(plan.resumes[0].sessionId).toBe(requester.session.id);
    expect(plan.deferred).toHaveLength(1);
    expect(plan.deferred).not.toContain(requester.session.id);
  });
});

describe("an idle session waiting on background work", () => {
  function shutdownWith(backgroundWork: Array<{ sessionId: string; detail: string }>) {
    restartResume.interruptRunningSessionsForShutdown(GATEWAY, { backgroundWork: () => backgroundWork });
  }

  it("is marked at shutdown and nudged at boot with the background message", () => {
    vi.useFakeTimers();
    const waiting = session("idle");

    shutdownWith([{ sessionId: waiting.id, detail: "1 background task" }]);
    expect(registry.getSession(waiting.id)?.status).toBe("idle");
    restartResume.resumeRestartInterruptedSessions(GATEWAY);
    vi.advanceTimersByTime(0);

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries.map((d) => d.targetSessionId)).toEqual([waiting.id]);
    expect(deliveries[0].payload.message).toContain("idle but waiting on background work");
  });

  it("is never marked twice, nor when it is a workflow attempt, errored, paused on a rate limit, or the requester", () => {
    const running = session("running");
    const attempt = session("idle");
    db.prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(attempt.id);
    const errored = session("error");
    const rateLimited = session("waiting");
    const requester = session("idle", { transportMeta: { [registry.RESTART_ACK_META_KEY]: new Date().toISOString() } });
    const detail = "1 background task";

    shutdownWith([running, attempt, errored, rateLimited, requester].map((s) => ({ sessionId: s.id, detail })));

    const candidates = restartResume.consumeRestartResumeCandidates();
    expect(candidates.resumable.map((c) => [c.session.id, c.reason])).toEqual([[running.id, "interrupted"]]);
  });

  it("is still marked when it carries a stale acknowledgement from a restart that never ran", () => {
    vi.useFakeTimers();
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const waiting = session("idle", { transportMeta: { [registry.RESTART_ACK_META_KEY]: twoHoursAgo } });

    shutdownWith([{ sessionId: waiting.id, detail: "1 background task" }]);
    restartResume.acknowledgeRestartRequesters(GATEWAY);
    restartResume.resumeRestartInterruptedSessions(GATEWAY);
    vi.advanceTimersByTime(0);

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries.map((d) => d.targetSessionId)).toEqual([waiting.id]);
    expect(deliveries[0].payload.message).toContain("idle but waiting on background work");
    expect(registry.listIdleRestartRequesters()).toEqual([]);
  });

  it("leaves idle sessions with no background work alone", () => {
    session("idle");

    shutdownWith([]);

    expect(restartResume.consumeRestartResumeCandidates()).toEqual(NONE);
  });
});

describe("backgroundWorkAtShutdown", () => {
  it("counts background tasks and in-flight agent requests, not auxiliary streams", () => {
    const activity = new Map([
      ["monitors", { activeStreams: 0, activeAgents: 0, activeMonitors: 2, lastActivityAt: 0 }],
      ["agents", { activeStreams: 3, activeAgents: 1, activeMonitors: 0, lastActivityAt: 0 }],
      ["aux-only", { activeStreams: 1, activeAgents: 0, activeMonitors: 0, lastActivityAt: 0 }],
      ["unclassified", { activeStreams: 1, lastActivityAt: 0 }],
    ]);

    expect(restartResume.backgroundWorkAtShutdown(activity)).toEqual([
      { sessionId: "monitors", detail: "2 background tasks" },
      { sessionId: "agents", detail: "1 background agent request" },
      { sessionId: "unclassified", detail: "1 background agent request" },
    ]);
  });
});
