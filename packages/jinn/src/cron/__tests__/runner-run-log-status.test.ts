import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCronJob } from "../runner.js";
import { appendRunLog } from "../jobs.js";
import { getSession, getSessionBySessionKey } from "../../sessions/registry.js";
import { logger } from "../../shared/logger.js";
import type { CronJob, Connector, JinnConfig, Session } from "../../shared/types.js";

/**
 * The run log used to record `success` the moment `route()` resolved,
 * whatever the turn actually did. An expired auth chain, a rate limit, or an engine
 * crash was logged green and the configured alert connector never fired, while the
 * same pass reconciled the linked Todo to `blocked` from the real session state.
 *
 * The settled session is the receipt. The run log has to read it.
 */

vi.mock("../jobs.js", () => ({ appendRunLog: vi.fn() }));
vi.mock("../../sessions/registry.js", () => ({ getSession: vi.fn(), getSessionBySessionKey: vi.fn() }));
vi.mock("../../gateway/org-registry.js", () => ({ orgRegistry: vi.fn(() => new Map()) }));
vi.mock("../../work-items/store.js", () => ({ createWorkItem: vi.fn(() => ({ id: "wi_test" })), linkSession: vi.fn() }));
vi.mock("../../work-items/reconcile.js", () => ({ reconcileWorkItem: vi.fn() }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const job: CronJob = { id: "test-job", name: "Test Job", enabled: true, schedule: "0 * * * *", prompt: "do something" };

/** A config whose failure alerts have somewhere to go, as a real one does. */
function makeConfig(): JinnConfig {
  return {
    engines: { default: "codex", codex: {} },
    logging: { file: false, stdout: false, level: "info" },
    cron: { alertConnector: "chat", alertChannel: "ops" },
  } as unknown as JinnConfig;
}

function makeSession(overrides: Partial<Session>): Session {
  return { id: "sess-123", status: "idle", attemptOutcome: null, lastError: null, ...overrides } as Session;
}

const sendMessage = vi.fn().mockResolvedValue(undefined);
const emit = vi.fn();

/** Runs one fire and hands back the run-log entry it wrote. */
async function runOnce(): Promise<Record<string, unknown>> {
  const sessionManager = { route: vi.fn().mockResolvedValue({ sessionId: "sess-123" }) } as never;
  const connectors = new Map<string, Connector>([["chat", { sendMessage } as unknown as Connector]]);
  await runCronJob(job, sessionManager, makeConfig(), connectors, { emit });
  return vi.mocked(appendRunLog).mock.calls[0]![1] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockReturnValue(undefined);
  vi.mocked(getSessionBySessionKey).mockReturnValue(undefined);
});

describe("runCronJob — what the run log says about a settled session", () => {
  it("records the failure and its reason when the session's attempt failed", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ attemptOutcome: "failed", lastError: "OAuth token expired" }),
    );

    const entry = await runOnce();

    expect(entry["status"]).toBe("error");
    expect(entry["error"]).toBe("OAuth token expired");
  });

  it("alerts on that failure exactly as a thrown error already does", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ attemptOutcome: "failed", lastError: "OAuth token expired" }),
    );

    await runOnce();

    expect(emit).toHaveBeenCalledWith("cron:run-finished", { jobId: "test-job", status: "error" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain("OAuth token expired");
  });

  it.each(["failed", "interrupted"] as const)(
    "names the outcome when a %s attempt left no error behind",
    async (attemptOutcome) => {
      vi.mocked(getSession).mockReturnValue(makeSession({ attemptOutcome }));

      const entry = await runOnce();

      expect(entry["status"]).toBe("error");
      expect(entry["error"]).toBe(`session ${attemptOutcome}`);
    },
  );

  it("keeps an empty error string as the reason it was recorded", async () => {
    vi.mocked(getSession).mockReturnValue(makeSession({ attemptOutcome: "failed", lastError: "" }));

    const entry = await runOnce();

    expect(entry["status"]).toBe("error");
    expect(entry["error"]).toBe("");
  });

  it("records a failure for a session left in error, whatever its attempt receipt says", async () => {
    vi.mocked(getSession).mockReturnValue(makeSession({ status: "error", lastError: "engine crashed" }));

    const entry = await runOnce();

    expect(entry["status"]).toBe("error");
    expect(entry["error"]).toBe("engine crashed");
  });

  it("leaves a succeeded attempt green and silent", async () => {
    vi.mocked(getSession).mockReturnValue(makeSession({ attemptOutcome: "succeeded" }));

    const entry = await runOnce();

    expect(entry["status"]).toBe("success");
    expect(entry["error"]).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stays green when no session row can be found for the fire", async () => {
    const entry = await runOnce();

    expect(getSessionBySessionKey).toHaveBeenCalled();
    expect(entry["status"]).toBe("success");
    expect(entry["error"]).toBeNull();
  });

  it("stays green and warns once when the registry read fails", async () => {
    vi.mocked(getSession).mockImplementation(() => {
      throw new Error("database is locked");
    });

    const entry = await runOnce();

    expect(entry["status"]).toBe("success");
    expect(entry["error"]).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
