import { describe, expect, it } from "vitest";
import {
  MAX_RESTART_RESUMES,
  RESTART_RESUME_STAGGER_MS,
  planRestartResumes,
  restartResumeMessage,
} from "../restart-resume.js";
import type { Session } from "../../shared/types.js";

const NOW = Date.parse("2026-08-22T21:00:00.000Z");

function candidate(id: string, lastActivity: string): Session {
  return { id, lastActivity } as Session;
}

describe("planRestartResumes", () => {
  it("wakes the most recently active session first and staggers the rest", () => {
    const plan = planRestartResumes({
      candidates: [
        candidate("older", "2026-08-22T20:00:00.000Z"),
        candidate("newest", "2026-08-22T20:59:00.000Z"),
        candidate("middle", "2026-08-22T20:30:00.000Z"),
      ],
      now: NOW,
    });

    expect(plan.resumes).toEqual([
      { sessionId: "newest", dueAt: NOW },
      { sessionId: "middle", dueAt: NOW + RESTART_RESUME_STAGGER_MS },
      { sessionId: "older", dueAt: NOW + 2 * RESTART_RESUME_STAGGER_MS },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("caps the stampede and names the overflow instead of dropping it", () => {
    const candidates = Array.from({ length: MAX_RESTART_RESUMES + 3 }, (_, index) =>
      candidate(`s${index}`, new Date(NOW - index * 1_000).toISOString()),
    );

    const plan = planRestartResumes({ candidates, now: NOW });

    expect(plan.resumes).toHaveLength(MAX_RESTART_RESUMES);
    // The oldest conversations are the ones held back, and each is named so the restart record can list it.
    expect(plan.deferred).toEqual([`s${MAX_RESTART_RESUMES}`, `s${MAX_RESTART_RESUMES + 1}`, `s${MAX_RESTART_RESUMES + 2}`]);
    expect(plan.resumes.at(-1)?.dueAt).toBe(NOW + (MAX_RESTART_RESUMES - 1) * RESTART_RESUME_STAGGER_MS);
  });

  it("orders deterministically when two sessions share a last activity", () => {
    const plan = planRestartResumes({
      candidates: [candidate("b", "2026-08-22T20:00:00.000Z"), candidate("a", "2026-08-22T20:00:00.000Z")],
      now: NOW,
    });

    expect(plan.resumes.map((resume) => resume.sessionId)).toEqual(["a", "b"]);
  });

  it("plans nothing for no candidates", () => {
    expect(planRestartResumes({ candidates: [], now: NOW })).toEqual({ resumes: [], deferred: [] });
  });
});

describe("restartResumeMessage", () => {
  it("names the restart, clears the operator, and demands re-verification", () => {
    const message = restartResumeMessage("0.31.0");
    expect(message).toContain("[Gateway] Restart complete (v0.31.0)");
    expect(message).toContain("not by the operator");
    expect(message).toContain("re-verify");
  });
});
