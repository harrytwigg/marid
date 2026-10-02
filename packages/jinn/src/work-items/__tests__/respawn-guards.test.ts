import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-respawn-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Comments = typeof import("../comments.js");
type Runs = typeof import("../runs.js");
type Guards = typeof import("../respawn-guards.js");
type Transitions = typeof import("../transitions.js");

let store: Store;
let comments: Comments;
let runs: Runs;
let guards: Guards;
let transitions: Transitions;
let db: import("better-sqlite3").Database;

const NOW = new Date("2026-08-13T12:00:00.000Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** A Todo carrying one settled run, which is what three of the four guards read. */
function todoWithSettledRun(title: string, settle: {
  outcome: import("../runs.js").TodoRunOutcome; endedAt: string; error?: string;
}): string {
  const item = store.createWorkItem({ title });
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: `s-${item.id}`, startedAt: minutesBefore(180) });
  runs.closeWorkItemRun(run.id, {
    outcome: settle.outcome,
    endedAt: settle.endedAt,
    ...(settle.error ? { error: settle.error } : {}),
  });
  return item.id;
}

/** `addComment` stamps the wall clock; every window here is relative to NOW, so
 *  the row is backdated once it exists. */
function comment(workItemId: string, body: string, createdAt: string, authorKind: "operator" | "employee" = "employee"): void {
  const added = comments.addComment({
    workItemId, body, authorKind, author: authorKind === "operator" ? "operator" : "a-lead",
  });
  db.prepare("UPDATE work_item_comments SET created_at = ? WHERE id = ?").run(createdAt, added.id);
}

/** A page's worth of newer traffic on top of whatever the case already wrote —
 *  the volume that used to decide, all by itself, what the guards could see. */
function chatter(workItemId: string, createdAt: string): void {
  for (let i = 0; i < 50; i++) comment(workItemId, `progress note ${i}`, createdAt);
}

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  runs = await import("../runs.js");
  guards = await import("../respawn-guards.js");
  transitions = await import("../transitions.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("rate_limit_cooldown", () => {
  it("holds while the cooldown runs on a run that closed rate_limited", () => {
    const id = todoWithSettledRun("quota", { outcome: "rate_limited", endedAt: minutesBefore(5) });
    const verdict = guards.checkRespawnGuard(id, NOW);
    expect(verdict).toMatchObject({ state: "held", guard: "rate_limit_cooldown" });
  });

  it("holds on a rate-limit-shaped error even when the outcome says otherwise", () => {
    const id = todoWithSettledRun("quota text", {
      outcome: "blocked", endedAt: minutesBefore(5), error: "429 Too Many Requests from the provider",
    });
    expect(guards.checkRespawnGuard(id, NOW)).toMatchObject({ state: "held", guard: "rate_limit_cooldown" });
  });

  it("allows once the cooldown window has passed", () => {
    const id = todoWithSettledRun("quota cleared", { outcome: "rate_limited", endedAt: minutesBefore(45) });
    expect(guards.checkRespawnGuard(id, NOW)).toEqual({ state: "allowed" });
  });

  it("wins over blocker_auth on text that carries both vocabularies", () => {
    // The reason the order is pinned: quota text ("usage limit exceeded") sits in
    // the same sentence as the credential text a wide auth matcher claims, and
    // losing that race parks the Todo behind a guard only a human can clear.
    const both = "Usage limit exceeded (429); the request was also rejected as 401 Unauthorized: invalid api key";
    const id = todoWithSettledRun("both", { outcome: "crashed", endedAt: minutesBefore(5), error: both });
    expect(guards.checkRespawnGuard(id, NOW)).toMatchObject({ state: "held", guard: "rate_limit_cooldown" });
  });
});

describe("blocker_auth", () => {
  it("holds when the last settled run failed on credentials", () => {
    const id = todoWithSettledRun("auth", {
      outcome: "crashed", endedAt: minutesBefore(5), error: "401 Unauthorized: the API key is invalid",
    });
    expect(guards.checkRespawnGuard(id, NOW)).toMatchObject({ state: "held", guard: "blocker_auth" });
  });

  it("allows an ordinary failure, which a retry can still fix", () => {
    const id = todoWithSettledRun("ordinary", {
      outcome: "crashed", endedAt: minutesBefore(5), error: "the build step exited with code 1",
    });
    expect(guards.checkRespawnGuard(id, NOW)).toEqual({ state: "allowed" });
  });
});

describe("recent_success", () => {
  it("holds on a run that completed under an hour ago with nobody having looked", () => {
    const id = todoWithSettledRun("fresh success", { outcome: "completed", endedAt: minutesBefore(20) });
    expect(guards.checkRespawnGuard(id, NOW)).toMatchObject({ state: "held", guard: "recent_success" });
  });

  it("allows once a human has commented after the run ended", () => {
    const id = todoWithSettledRun("reviewed success", { outcome: "completed", endedAt: minutesBefore(20) });
    comment(id, "looks right, carry on", minutesBefore(10), "operator");
    expect(guards.checkRespawnGuard(id, NOW)).toEqual({ state: "allowed" });
  });

  it("does not count an employee comment as a human having looked", () => {
    const id = todoWithSettledRun("self reported", { outcome: "completed", endedAt: minutesBefore(20) });
    comment(id, "built it", minutesBefore(10));
    expect(guards.checkRespawnGuard(id, NOW)).toMatchObject({ state: "held", guard: "recent_success" });
  });

  it("allows once the hour has passed", () => {
    const id = todoWithSettledRun("stale success", { outcome: "completed", endedAt: minutesBefore(90) });
    expect(guards.checkRespawnGuard(id, NOW)).toEqual({ state: "allowed" });
  });

  it("still sees the human's comment once a chatty Todo has buried it under a page of newer ones", () => {
    const id = todoWithSettledRun("buried review", { outcome: "completed", endedAt: minutesBefore(30) });
    comment(id, "looks right, carry on", minutesBefore(25), "operator");
    chatter(id, minutesBefore(20));
    expect(guards.checkRespawnGuard(id, NOW)).toEqual({ state: "allowed" });
  });

  it("counts the operator sending it back from review", () => {
    const item = store.createWorkItem({ title: "sent back for another round", status: "in_review" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: `s-${item.id}`, startedAt: minutesBefore(180) });
    runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: minutesBefore(30) });

    const bounced = transitions.transition(item.id, "executing", "operator", { bounce: true });
    expect(bounced.escalated).toBe(false); // no round ceiling: every bounce returns to executing
    db.prepare("UPDATE work_item_events SET created_at = ? WHERE id = ?").run(minutesBefore(20), bounced.event!.id);

    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });
});

describe("active_pr", () => {
  it("holds on a recent comment carrying a pull request URL", () => {
    const item = store.createWorkItem({ title: "pr open" });
    comment(item.id, "opened https://github.com/acme/widget/pull/42 for review", minutesBefore(10));
    expect(guards.checkRespawnGuard(item.id, NOW)).toMatchObject({ state: "held", guard: "active_pr" });
  });

  it("holds on a recent comment naming this Todo's build branch", () => {
    const item = store.createWorkItem({ title: "branch open" });
    comment(item.id, `pushed to build/${item.id}-the-slice`, minutesBefore(10));
    expect(guards.checkRespawnGuard(item.id, NOW)).toMatchObject({ state: "held", guard: "active_pr" });
  });

  it("allows when recent comments carry neither", () => {
    const item = store.createWorkItem({ title: "just chatter" });
    comment(item.id, "starting on this now", minutesBefore(10));
    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });

  it("allows when the only such comment is older than the window", () => {
    const item = store.createWorkItem({ title: "stale pr" });
    comment(item.id, "opened https://github.com/acme/widget/pull/7", minutesBefore(180));
    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });

  it("still sees the pull request once newer comments have buried it", () => {
    const item = store.createWorkItem({ title: "buried pr" });
    comment(item.id, "opened https://github.com/acme/widget/pull/9 for review", minutesBefore(30));
    chatter(item.id, minutesBefore(20));
    expect(guards.checkRespawnGuard(item.id, NOW)).toMatchObject({ state: "held", guard: "active_pr" });
  });

  it("allows once the operator has moved the status after the branch comment", () => {
    // The sequence that parked a real Todo through four re-arms: a handback
    // comment that merely names the branch, then the operator saying "go".
    const item = store.createWorkItem({ title: "re-armed after a handback" });
    comment(item.id, `branch build/${item.id}-a-slice is intact`, minutesBefore(20));
    const moved = transitions.transition(item.id, "executing", "operator");
    db.prepare("UPDATE work_item_events SET created_at = ? WHERE id = ?").run(minutesBefore(10), moved.event!.id);

    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });

  it("allows once the operator has commented after the pull request comment", () => {
    const item = store.createWorkItem({ title: "re-armed after a pull request" });
    comment(item.id, "opened https://github.com/acme/widget/pull/11 for review", minutesBefore(20));
    comment(item.id, "seen it, run it again", minutesBefore(10), "operator");
    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });

  it("still holds when the human's look came before the comment that triggered it", () => {
    // The override is anchored to the triggering comment, not to "any human
    // ever": work announced AFTER the operator looked is work they have not seen.
    const item = store.createWorkItem({ title: "looked, then built" });
    comment(item.id, "go ahead", minutesBefore(40), "operator");
    comment(item.id, `pushed to build/${item.id}-a-slice`, minutesBefore(10));
    expect(guards.checkRespawnGuard(item.id, NOW)).toMatchObject({ state: "held", guard: "active_pr" });
  });

  it("does not read a longer-numbered Todo's branch as this Todo's own", () => {
    const item = store.createWorkItem({ title: "prefix neighbour" });
    // `build/AAA-10` shares every character of `build/AAA-1` — the neighbour's
    // branch, not this Todo's, and a Todo held on it waits on work nobody is
    // doing for it.
    comment(item.id, `pushed to build/${item.id}0-a-different-todo`, minutesBefore(10));
    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });
});

describe("a Todo with no history at all", () => {
  it("allows", () => {
    const item = store.createWorkItem({ title: "brand new" });
    expect(guards.checkRespawnGuard(item.id, NOW)).toEqual({ state: "allowed" });
  });
});
