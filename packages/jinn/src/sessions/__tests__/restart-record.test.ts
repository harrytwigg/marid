import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-record-"));
process.env.JINN_HOME = home;

const gatewayConfig: { resumeInterruptedSessions?: boolean } = {};
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: gatewayConfig })),
}));

type Registry = typeof import("../registry.js");
type RestartResume = typeof import("../restart-resume.js");
type RestartRecord = typeof import("../restart-record.js");
let registry: Registry;
let restartResume: RestartResume;
let restartRecord: RestartRecord;
let recordFile: string;
let db: import("better-sqlite3").Database;

const OLD_GATEWAY = { bootId: "old00001", gatewayVersion: "0.33.3" };
const NEW_GATEWAY = { bootId: "new00002", gatewayVersion: "0.33.3" };

beforeAll(async () => {
  registry = await import("../registry.js");
  restartResume = await import("../restart-resume.js");
  restartRecord = await import("../restart-record.js");
  recordFile = (await import("../../shared/paths.js")).RESTART_RECORD_FILE;
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM meta WHERE key LIKE 'restart.%'").run();
  fs.rmSync(recordFile, { force: true });
  fs.rmSync(`${recordFile}.1`, { force: true });
  delete gatewayConfig.resumeInterruptedSessions;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function running(overrides: Record<string, unknown> = {}) {
  const created = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:running", employee: "senior-developer" });
  db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(created.id);
  if (Object.keys(overrides).length > 0) registry.updateSession(created.id, overrides);
  return registry.getSession(created.id)!;
}

function lines() {
  return fs.readFileSync(recordFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("the restart record on shutdown", () => {
  it("names every running session the shutdown interrupted, with who was running it and which boot cut it", () => {
    const worker = running({ title: "Restart resilience" });
    db.prepare("UPDATE sessions SET work_item_id = 'TST-86' WHERE id = ?").run(worker.id);
    registry.createSession({ engine: "claude", source: "web", sourceRef: "web:idle" });

    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    expect(lines()).toEqual([
      expect.objectContaining({
        event: "interrupted",
        cause: "shutdown",
        resume: "restart-resume",
        bootId: "old00001",
        gatewayVersion: "0.33.3",
        sessionId: worker.id,
        employee: "senior-developer",
        engine: "claude",
        workItemId: "TST-86",
        title: "Restart resilience",
        status: "running",
        at: expect.any(String),
      }),
    ]);
  });

  it("records the session that asked for the restart as owed a notice, not a nudge", () => {
    const requester = running({ transportMeta: { [registry.RESTART_ACK_META_KEY]: new Date().toISOString() } });

    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    expect(lines()).toEqual([expect.objectContaining({ sessionId: requester.id, cause: "shutdown", resume: "restart-notice" })]);
  });

  it("survives the boot that consumes the resume marks", () => {
    const worker = running();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    restartResume.consumeRestartResumeCandidates();

    // The DB has forgotten which restart interrupted it; the record has not.
    expect(registry.getSession(worker.id)?.transportMeta ?? null).toBeNull();
    expect(lines().map((entry) => entry.sessionId)).toEqual([worker.id]);
  });

  it("never takes the shutdown down when the record cannot be written", () => {
    running();
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.mkdirSync(recordFile); // a directory where the file should be: every append fails

    expect(() => restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY)).not.toThrow();
    expect(registry.listSessions({ status: "interrupted" })).toHaveLength(1);
    fs.rmdirSync(recordFile);
  });
});

describe("the restart record for workflow attempts", () => {
  function runningAttempt() {
    const attempt = running();
    db.prepare("UPDATE sessions SET workflow_kind = 'phase', workflow_id = 'release', workflow_name = 'Release', workflow_run_id = 'run-1', workflow_trigger_source = 'manual', workflow_phase_node_id = 'build', workflow_phase_name = 'Build', workflow_phase_index = 1, workflow_phase_round = 1, workflow_phase_attempt = 1 WHERE id = ?").run(attempt.id);
    return registry.getSession(attempt.id)!;
  }

  it("records a clean shutdown's workflow attempt under the old boot, and leaves it running for the workflow sweep", () => {
    const attempt = runningAttempt();

    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    expect(lines()).toEqual([expect.objectContaining({
      event: "interrupted", cause: "shutdown", resume: "workflow-runtime", bootId: "old00001", sessionId: attempt.id, workflowKind: "phase",
    })]);
    expect(registry.getSession(attempt.id)?.status).toBe("running");
    expect(registry.recoverStaleWorkflowAttemptSessions()).toBe(1);
  });

  it("does not record the same attempt again as a crash when the next boot finds it still running", () => {
    const attempt = runningAttempt();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    const boot = restartResume.recordSessionsRunningAtBoot(NEW_GATEWAY);

    expect(boot).toEqual({ recorded: [], cleanShutdownBootId: "old00001" });
    expect(lines().filter((entry) => entry.sessionId === attempt.id)).toHaveLength(1);
  });

  it("records everything still running as stale-on-boot under the new boot when no shutdown receipt exists", () => {
    const attempt = runningAttempt();
    const chat = running();

    const boot = restartResume.recordSessionsRunningAtBoot(NEW_GATEWAY);

    expect(boot.cleanShutdownBootId).toBeNull();
    expect(boot.recorded.map((session) => session.id).sort()).toEqual([attempt.id, chat.id].sort());
    expect(lines()).toEqual(expect.arrayContaining([
      expect.objectContaining({ cause: "stale-on-boot", resume: "workflow-runtime", bootId: "new00002", sessionId: attempt.id }),
      expect.objectContaining({ cause: "stale-on-boot", resume: "restart-resume", bootId: "new00002", sessionId: chat.id }),
    ]));
  });

  it("consumes the shutdown receipt, so a crash of the new gateway is not mistaken for a clean shutdown", () => {
    runningAttempt();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    restartResume.recordSessionsRunningAtBoot(NEW_GATEWAY);

    const crashed = restartResume.recordSessionsRunningAtBoot({ bootId: "new00003", gatewayVersion: "0.33.3" });

    expect(crashed.cleanShutdownBootId).toBeNull();
    expect(crashed.recorded).toHaveLength(1);
  });

  it("still records a conversational row that slipped past a clean shutdown", () => {
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    const slipped = running();

    const boot = restartResume.recordSessionsRunningAtBoot(NEW_GATEWAY);

    expect(boot.cleanShutdownBootId).toBe("old00001");
    expect(boot.recorded.map((session) => session.id)).toEqual([slipped.id]);
  });
});

describe("the restart record on boot", () => {
  it("records a nudged session against the new boot, with the delivery that carries the nudge", () => {
    vi.useFakeTimers();
    const worker = running();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    restartResume.resumeRestartInterruptedSessions(NEW_GATEWAY);
    vi.advanceTimersByTime(0);

    const [delivery] = registry.listPendingSessionDeliveries();
    expect(delivery.targetSessionId).toBe(worker.id);
    expect(lines().at(-1)).toEqual(expect.objectContaining({
      event: "resume",
      outcome: "nudged",
      bootId: "new00002",
      sessionId: worker.id,
      employee: "senior-developer",
      detail: `delivery ${delivery.id}`,
    }));
  });

  it("records a session the queue replay owns as queue-replay, and sends it no nudge", () => {
    vi.useFakeTimers();
    const worker = running();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    registry.enqueueQueueItem(worker.id, worker.sessionKey || worker.id, "resume me");

    restartResume.resumeRestartInterruptedSessions(NEW_GATEWAY);
    vi.advanceTimersByTime(10 * 60_000);

    expect(registry.listPendingSessionDeliveries()).toEqual([]);
    expect(lines().at(-1)).toEqual(expect.objectContaining({ event: "resume", outcome: "queue-replay", sessionId: worker.id }));
  });

  it("records every session left for the operator when nudges are switched off", () => {
    vi.useFakeTimers();
    const worker = running();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    gatewayConfig.resumeInterruptedSessions = false;

    restartResume.resumeRestartInterruptedSessions(NEW_GATEWAY);
    vi.advanceTimersByTime(10 * 60_000);

    expect(lines().at(-1)).toEqual(expect.objectContaining({ event: "resume", outcome: "disabled", sessionId: worker.id }));
  });

  it("names each session deferred over the cap, so none of them stalls silently", () => {
    vi.useFakeTimers();
    const sessions = Array.from({ length: restartResume.MAX_RESTART_RESUMES + 2 }, () => running());
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    // The shutdown stamps every session with the same instant; age the conversations so the newest wake first.
    sessions.forEach((session, index) => {
      registry.updateSession(session.id, { lastActivity: new Date(Date.now() - index * 60_000).toISOString() });
    });

    restartResume.resumeRestartInterruptedSessions(NEW_GATEWAY);
    vi.advanceTimersByTime(restartResume.MAX_RESTART_RESUMES * restartResume.RESTART_RESUME_STAGGER_MS);

    const resumes = lines().filter((entry) => entry.event === "resume");
    const deferred = resumes.filter((entry) => entry.outcome === "deferred").map((entry) => entry.sessionId);
    expect(deferred).toEqual(sessions.slice(-2).map((session) => session.id));
    expect(resumes.filter((entry) => entry.outcome === "nudged")).toHaveLength(restartResume.MAX_RESTART_RESUMES);
    expect(registry.listPendingSessionDeliveries()).toHaveLength(restartResume.MAX_RESTART_RESUMES);
  });

  it("records the reason when a nudge cannot be claimed", () => {
    vi.useFakeTimers();
    const worker = running();
    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    restartResume.resumeRestartInterruptedSessions(NEW_GATEWAY);
    // The attempt moved on before the staggered nudge fired, so no token can be minted for the interrupted one.
    db.prepare("UPDATE sessions SET attempt_token = NULL, attempt_terminal_version = 7 WHERE id = ?").run(worker.id);
    vi.advanceTimersByTime(0);

    expect(registry.listPendingSessionDeliveries()).toEqual([]);
    expect(lines().at(-1)).toEqual(expect.objectContaining({ event: "resume", outcome: "no-attempt-token", sessionId: worker.id }));
  });
});

describe("listAllRunningSessions", () => {
  it("includes the archived and workflow-phase rows the display list hides", () => {
    const plain = running();
    const archived = running({ archivedAt: new Date().toISOString() });
    const attempt = running();
    db.prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(attempt.id);
    registry.createSession({ engine: "claude", source: "web", sourceRef: "web:idle" });

    const rows = registry.listAllRunningSessions();
    expect(rows.map((row) => row.session.id).sort()).toEqual([plain.id, archived.id, attempt.id].sort());
    expect(rows.filter((row) => row.workflowAttempt).map((row) => row.session.id)).toEqual([attempt.id]);
    expect(registry.listSessions({ status: "running" }).map((session) => session.id)).toEqual([plain.id]);
  });
});

describe("restart record rotation", () => {
  it("rotates the live file once it reaches the cap, keeping one previous generation", () => {
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, "x".repeat(restartRecord.RESTART_RECORD_MAX_BYTES));
    const worker = running();

    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);

    expect(fs.statSync(`${recordFile}.1`).size).toBe(restartRecord.RESTART_RECORD_MAX_BYTES);
    expect(lines()).toEqual([expect.objectContaining({ sessionId: worker.id })]);
  });
});
