import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, home, startRouteHarness, stopRouteHarness, type WorkItems } from "./todo-route-harness.js";

/**
 * the Auto-Dispatch page's reads. The preview route's behaviour is
 * covered in idle-capacity-route.test.ts (unchanged by its move into the
 * domain module); this file is the history and the policy routes.
 */

let workItems: WorkItems;
let comments: typeof import("../../work-items/comments.js");
let record: typeof import("../../shared/idle-capacity-record.js");
let idle: typeof import("../../shared/idle-capacity.js");

beforeAll(async () => {
  ({ workItems } = await startRouteHarness());
  comments = await import("../../work-items/comments.js");
  record = await import("../../shared/idle-capacity-record.js");
  idle = await import("../../shared/idle-capacity.js");
});

afterAll(async () => {
  await stopRouteHarness();
});

function startNote(sessionId: string, charged = 1): string {
  const now = Date.now();
  const verdict = idle.evaluateIdleCapacity({
    name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(now).toISOString(), models: [],
    windows: [
      { name: "5h", usedPercent: 12, resetsAt: Math.floor(now / 1000) + 30 * 60 },
      { name: "7d", usedPercent: 40, resetsAt: Math.floor(now / 1000) + 3 * 24 * 3600 },
    ],
  }, "daytime", idle.resolveIdleCapacityPolicy({ enabled: true }), now);
  if (!verdict.act) throw new Error(verdict.reason);
  return record.formatStartNote({ verdict, sessionId, charged, cap: 2 });
}

describe("GET /api/idle-capacity/history", () => {
  it("lists the loop's own system comments, newest first, joined with the Todo as it is now", async () => {
    const first = workItems.createWorkItem({ title: "Started overnight", source: "human" });
    const second = workItems.createWorkItem({ title: "Started later", source: "human" });
    comments.addComment({ workItemId: first.id, body: startNote("sess-a"), author: "idle-capacity", authorKind: "system" });
    comments.addComment({ workItemId: second.id, body: startNote("sess-b", 2), author: "idle-capacity", authorKind: "system" });
    // Not history: another system author, an employee whose slug is the actor's
    // name, and a start comment the operator deleted (a tombstone has no body).
    comments.addComment({ workItemId: first.id, body: "Reconciled.", author: "reconciler", authorKind: "system" });
    comments.addComment({ workItemId: first.id, body: startNote("sess-x"), author: "idle-capacity", authorKind: "employee" });
    const deleted = comments.addComment({ workItemId: second.id, body: startNote("sess-gone"), author: "idle-capacity", authorKind: "system" });
    comments.tombstoneComment(deleted.id, { author: "operator", authorKind: "operator", operator: true });
    (await import("../../work-items/transitions.js")).transitionDerived(second.id, "cancelled", "operator");

    const response = await call("GET", "/api/idle-capacity/history");
    expect(response.status).toBe(200);
    const ours = response.body.starts.filter((start: { workItemId: string }) => [first.id, second.id].includes(start.workItemId));
    expect(ours.map((start: { sessionId: string }) => start.sessionId)).toEqual(["sess-b", "sess-a"]);
    expect(ours[0]).toMatchObject({
      partial: false,
      workItemId: second.id,
      title: "Started later",
      status: "cancelled",
      tier: "daytime",
      trigger: "5h",
      fiveHour: { name: "5h", usedPercent: 12, minutesToReset: 30 },
      weekly: [{ name: "7d", usedPercent: 40, minutesToReset: 3 * 24 * 60 }],
      charged: 2,
      cap: 2,
    });
    expect(ours[0].startedAt).toMatch(/^\d{4}-/);
  });

  it("clamps the limit", async () => {
    expect((await call("GET", "/api/idle-capacity/history?limit=1")).body.starts).toHaveLength(1);
    expect((await call("GET", "/api/idle-capacity/history?limit=-5")).status).toBe(200);
  });
});

describe("GET /api/idle-capacity/usage", () => {
  it("serves the retained readings since the clamped hours", async () => {
    const usage = await import("../../shared/claude-usage-history.js");
    const now = Date.now();
    const live = (at: number, used: number) => usage.recordClaudeUsageSample({
      name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(at).toISOString(), models: [],
      windows: [{ name: "5h", usedPercent: used, resetsAt: Math.floor(now / 1000) + 3600 }],
    }, at);
    live(now - 20 * 60 * 60_000, 5);
    live(now - 60 * 60_000, 30);
    live(now, 40);
    const all = await call("GET", "/api/idle-capacity/usage");
    expect(all.status).toBe(200);
    expect(all.body.samples.map((sample: { windows: Array<{ usedPercent: number }> }) => sample.windows[0].usedPercent)).toEqual([5, 30, 40]);
    const recent = await call("GET", "/api/idle-capacity/usage?hours=12");
    expect(recent.body.samples).toHaveLength(2);
    expect((await call("GET", "/api/idle-capacity/usage?hours=9999")).body.samples).toHaveLength(3);
  });
});

describe("GET /api/idle-capacity/policy", () => {
  it("resolves defaults over the file block and carries the same revision GET /api/config does", async () => {
    fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  idleCapacity:\n    enabled: true\n");
    const policy = await call("GET", "/api/idle-capacity/policy");
    const config = await call("GET", "/api/config");
    expect(policy.status).toBe(200);
    // The harness's in-memory config has no block, so the resolved policy is
    // the defaults; `configured` is the raw block (none here). What matters is
    // that every key is explicit and the revision is the file's.
    expect(policy.body.policy.tiers.overnight.fiveHour.maxUsedPercent).toBe(85);
    expect(policy.body.policy.enabled).toBe(false);
    expect(policy.body.configured).toBeNull();
    expect(policy.headers["x-jinn-config-revision"]).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.headers["x-jinn-config-revision"]).toBe(config.headers["x-jinn-config-revision"]);
  });

  it("does not need the loop", async () => {
    expect((await call("GET", "/api/idle-capacity")).status).toBe(503);
    expect((await call("GET", "/api/idle-capacity/policy")).status).toBe(200);
  });
});
