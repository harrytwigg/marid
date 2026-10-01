import { describe, expect, it } from "vitest";
import {
  classifyRecovery,
  GENERIC_OPERATOR_REASON,
  mayReplaceRecoveryLane,
} from "../recovery.js";

/**
 * PLA-240 replay: the audit's representative incidents, written as classifier
 * contracts before any recovery writes exist. Generic fixture ids only.
 */

describe("historical incident replay — classifier", () => {
  it("transient quota block classifies as recovering, not operator", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-1", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "rate_limited",
        error: "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
    });
    expect(verdict).toMatchObject({ class: "transient", lane: "recovering" });
  });

  it("code failure routes to manager, not operator", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-2", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "crashed",
        error: "the build step exited with code 1",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
    });
    expect(verdict).toMatchObject({ class: "code", lane: "manager" });
  });

  it("verification failure routes to the independent verifier lane", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-3", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "failed",
        error: "independent review rejected the diff",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      verifyMode: "thorough",
    });
    expect(verdict).toMatchObject({ class: "verification", lane: "manager" });
  });

  it("security/auth-terminal is manager, not a clock retry", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-4", status: "blocked", assignee: "platform-worker", source: "session" },
      lastRun: {
        id: "run_old",
        outcome: "crashed",
        error: "401 Unauthorized: invalid api key",
        endedAt: "2026-08-20T12:00:00.000Z",
      },
    });
    expect(verdict).toMatchObject({ class: "security", lane: "manager" });
  });

  it("operator-only pending approval is Needs you", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-5", status: "in_review", assignee: "platform-worker", source: "session" },
      approval: { state: "pending", operatorOnly: true },
    });
    expect(verdict).toMatchObject({ class: "operator", lane: "operator" });
  });

  it("ordinary backlog never classifies as recovering", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-6", status: "backlog", assignee: null, source: "human" },
    });
    expect(verdict.lane).not.toBe("recovering");
    expect(verdict.class).toBe("operator");
  });

  it("an approved completed leftover still in_review is Manager attention, not Needs you", () => {
    const verdict = classifyRecovery({
      todo: { id: "PLA-15", status: "in_review", assignee: "platform-worker", source: "workflow" },
      lastRun: {
        id: "run_landed",
        outcome: "completed",
        error: null,
        endedAt: "2026-08-20T12:00:00.000Z",
      },
      approval: { state: "approved", operatorOnly: false },
    });
    expect(verdict).toMatchObject({ lane: "manager" });
    expect(verdict.lane).not.toBe("operator");
  });

  it("execution past the 4h timeout with a dead session is manager, and the same run keeps it there while the session lives", () => {
    const stalled = {
      todo: { id: "PLA-17", status: "executing", assignee: "platform-worker", source: "workflow" },
      openRun: { startedAt: "2026-08-20T12:00:00.000Z", sessionInFlight: false },
      now: new Date("2026-08-20T17:00:00.000Z"),
    };
    expect(classifyRecovery(stalled)).toMatchObject({ class: "code", lane: "manager" });
    expect(classifyRecovery({ ...stalled, openRun: { ...stalled.openRun, sessionInFlight: true } }).lane).toBe("operator");
  });

  it("an in_review Todo with no pending approval and no reviewer is manager, not Needs you", () => {
    const verdict = classifyRecovery({ todo: { id: "PLA-18", status: "in_review", assignee: null, source: "workflow" } });
    expect(verdict).toMatchObject({ lane: "manager", reason: "in review with no pending approval and no reviewer" });
  });
});

describe("mayReplaceRecoveryLane", () => {
  const generic = { class: "operator" as const, lane: "operator" as const, reason: GENERIC_OPERATOR_REASON };
  const leftover = { class: "operator" as const, lane: "manager" as const, reason: "approved landing is still open" };
  const operatorOnly = { class: "operator" as const, lane: "operator" as const, reason: "operator-only approval is a genuine authority decision" };

  it("a generic fallback cannot downgrade an unresolved manager lane", () => {
    expect(mayReplaceRecoveryLane({ lane: "manager" }, generic, "in_review")).toBe(false);
    expect(mayReplaceRecoveryLane({ lane: "recovering" }, generic, "blocked")).toBe(false);
  });

  it("a specific leftover manager verdict may refresh the row", () => {
    expect(mayReplaceRecoveryLane({ lane: "manager" }, leftover, "in_review")).toBe(true);
  });

  it("operator-only authority may replace manager (Needs you)", () => {
    expect(mayReplaceRecoveryLane({ lane: "manager" }, operatorOnly, "in_review")).toBe(true);
  });

  it("a resolved Todo may drop a stale manager row", () => {
    expect(mayReplaceRecoveryLane({ lane: "manager" }, generic, "done")).toBe(true);
    expect(mayReplaceRecoveryLane({ lane: "manager" }, generic, "cancelled")).toBe(true);
  });
});
