import { describe, it, expect } from "vitest";
import { summarizeCronRun } from "../run-summary.js";

const SESSION_ID = "3f2b8c1e-9a44-4d7b-8b1a-5c0e7d216f90";

describe("summarizeCronRun sessionId", () => {
  it("emits a UUID sessionId so a run row can link to its session", () => {
    const out = summarizeCronRun({ timestamp: "2026-08-01T03:00:00.000Z", status: "success", sessionId: SESSION_ID });
    expect(out.sessionId).toBe(SESSION_ID);
  });

  it("omits sessionId for a fire that never spawned a session", () => {
    // An errored fire can fail before it spawns a session.
    expect(summarizeCronRun({ status: "error", sessionId: null })).not.toHaveProperty("sessionId");
    expect(summarizeCronRun({ status: "error" })).not.toHaveProperty("sessionId");
  });

  it("omits a sessionId that is not a UUID string", () => {
    for (const value of [42, true, {}, [SESSION_ID], "", "not-a-uuid", `${SESSION_ID} `, `${SESSION_ID}${SESSION_ID}`]) {
      expect(summarizeCronRun({ status: "success", sessionId: value })).not.toHaveProperty("sessionId");
    }
  });

  it("leaves the rest of the allowlist untouched", () => {
    const out = summarizeCronRun({
      timestamp: "2026-08-01T03:00:00.000Z",
      sessionKey: "cron:nightly:2026-08-01T03:00:00.000Z",
      status: "success",
      durationMs: 1200,
      sessionId: SESSION_ID,
      prompt: "secret",
    });
    expect(out).toEqual({
      timestamp: "2026-08-01T03:00:00.000Z",
      sessionKey: "cron:nightly:2026-08-01T03:00:00.000Z",
      status: "success",
      durationMs: 1200,
      sessionId: SESSION_ID,
    });
  });
});
