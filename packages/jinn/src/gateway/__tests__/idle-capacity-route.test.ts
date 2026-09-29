import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, config, context, firstUserMessage, startRouteHarness, stopRouteHarness, unavailableEngines, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * the idle-capacity loop wired to the real Todo Dispatcher spawn, and
 * the read-only preview route over it. The loop's own guards and eligibility
 * rules are covered in idle-capacity-loop.test.ts; this is the seam between
 * them and the gateway.
 */

let registry: Registry;
let workItems: WorkItems;

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("GET /api/idle-capacity", () => {
  it("answers 503 while no loop is running", async () => {
    const response = await call("GET", "/api/idle-capacity");
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/idle-capacity loop/);
  });

  it("previews without starting, then starts the real Todo Dispatcher from a tick", async () => {
    const { startIdleCapacityAutoStart } = await import("../idle-capacity.js");
    const item = workItems.createWorkItem({ title: "Use the spare window", source: "human", priority: 3 });
    const sessionsBefore = registry.countSessions();
    const now = Date.now();
    const loop = startIdleCapacityAutoStart({
      // The Todo Dispatcher runs on the default engine (codex here). The
      // "Claude is installed" guard reads claude.bin, which is pointed at an
      // executable that exists so the host's PATH is not consulted.
      getConfig: () => {
        const base = config();
        return { ...base, gateway: { ...base.gateway, idleCapacity: { enabled: true } }, engines: { ...base.engines, claude: { bin: process.execPath, model: "opus" } } };
      },
      context,
      collect: async () => ({
        name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(now).toISOString(), models: [],
        windows: [
          { name: "5h", usedPercent: 12, resetsAt: Math.floor(now / 1000) + 30 * 60 },
          { name: "7d", usedPercent: 40, resetsAt: Math.floor(now / 1000) + 3 * 24 * 3600 },
        ],
      }),
      activeSessions: () => 0,
    });
    context.idleCapacity = loop;
    try {
      const preview = await call("GET", "/api/idle-capacity");
      expect(preview.status).toBe(200);
      expect(preview.body.reason).toBe(`would start ${item.id}`);
      expect(preview.body.eligible[0]).toEqual({ workItemId: item.id, title: "Use the spare window", priority: 3 });
      expect(preview.body.policy.enabled).toBe(true);
      expect(preview.body.verdict.act).toBe(true);
      expect(registry.countSessions()).toBe(sessionsBefore);

      const tick = await loop.tick();
      expect(tick.started?.workItemId).toBe(item.id);
      const linked = await call("GET", `/api/work-items/${item.id}/sessions`);
      expect(linked.body).toContainEqual(expect.objectContaining({
        id: tick.started?.sessionId,
        employee: "todo-dispatcher",
        status: "running",
      }));
      const comments = await call("GET", `/api/work-items/${item.id}/comments`);
      expect(comments.body.comments.at(-1)).toMatchObject({ authorKind: "system", author: "idle-capacity" });
      // The Dispatcher is told what the start is for, so its routing can serve it.
      expect(firstUserMessage(registry, tick.started!.sessionId)).toMatch(/Prefer an employee whose engine is claude/);

      // The Todo has left backlog (a live Dispatcher session is linked to it),
      // so the next tick has nothing else to start and does not start it twice.
      const again = await loop.tick();
      expect(again.started).toBeUndefined();
      expect((await call("GET", `/api/work-items/${item.id}/sessions`)).body).toHaveLength(1);
      expect((await call("GET", "/api/idle-capacity")).body.startedThisWindow).toBe(1);
    } finally {
      loop.stop();
      delete context.idleCapacity;
    }
  });
});

describe("POST /api/work-items/:id/dispatch after the extraction", () => {
  it("still answers an unavailable Dispatcher engine with the preflight's own 502", async () => {
    const item = workItems.createWorkItem({ title: "Engine is down", source: "human" });
    unavailableEngines.add("codex");
    try {
      const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
      expect(response.status).toBe(502);
      expect(response.body.error).toMatch(/engine "codex" not available/);
    } finally {
      unavailableEngines.delete("codex");
    }
  });
});
