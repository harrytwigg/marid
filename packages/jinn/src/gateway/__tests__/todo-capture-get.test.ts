import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// The harness comes FIRST, before `logger` or anything else that reaches
// shared/paths.js: paths freezes JINN_HOME at import, so an earlier one would
// leave this file on the run-wide home. startRouteHarness asserts it.
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";
import { logger } from "../../shared/logger.js";

/**
 * What the capture GET reports about a capture already in flight, over a real
 * gateway.
 *
 * The stage rules themselves are unit-tested against fixtures in
 * todo-capture-stage.test.ts. What can only be checked here is that the route
 * feeds those rules the TRUE facts — the right session, the right Todos, the
 * link a landing wrote.
 *
 * Both halves of acceptance (d) also live here, because a reason reaching the
 * log is one property with two paths to it: a refusal that is thrown, and a
 * failure that is derived. Testing them apart is how one of them ends up
 * untested. What the POST refuses before it spends anything is
 * todo-capture-route.test.ts.
 */

let registry: Registry;
let workItems: WorkItems;
/** Headers that make a call the SESSION's own rather than the operator's. The
 *  capability is minted the same way the gateway mints it for a real engine
 *  child, because the landing route deliberately refuses an operator caller. */
let asSession: (sessionId: string) => Record<string, string>;

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
  const { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, ensureSessionCapability } = await import("../../mcp/identity.js");
  asSession = (sessionId) => ({
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  });
});
afterAll(async () => {
  await stopRouteHarness();
});

describe("GET /api/todo-captures/:id", () => {
  it("404s an unknown capture", async () => {
    const response = await call("GET", "/api/todo-captures/not-a-session");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/not found/);
  });

  // The reload-recovery property: the stage is read back out of real state, so
  // a second reader with no memory of the first sees the same answer.
  it("reports the Todo the capture's session created, with no stage written down anywhere", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture that will produce a Todo" });
    const captureId = started.body.captureId as string;

    const item = workItems.createWorkItem({
      title: "Closed rail scrolls under the board header on mobile",
      source: "session",
      sourceRef: `session:${captureId}:6cd126d21e61`,
      createdBy: "todo-shaper",
      department: "platform",
    });

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      captureId,
      stage: "created",
      workItemId: item.id,
      workItemTitle: "Closed rail scrolls under the board header on mobile",
      routedTo: null,
    });
  });

  it("advances to routed, naming the employee, once a delegate is linked to that Todo", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture that will be delegated" });
    const captureId = started.body.captureId as string;
    const item = workItems.createWorkItem({
      title: "Delegated onward",
      source: "session",
      sourceRef: `session:${captureId}:6cd126d21e62`,
      createdBy: "todo-shaper",
    });

    const worker = registry.createSession({
      engine: "codex", source: "web", sourceRef: "route-worker:capture", connector: "web",
      employee: "route-worker", prompt: "do the work",
    });
    workItems.linkSession(item.id, worker.id);

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.body).toMatchObject({
      stage: "routed",
      workItemId: item.id,
      routedTo: { kind: "employee", employee: "route-worker", sessionId: worker.id },
    });
  });

  /**
   * The dedupe path, over the real route rather than against fixtures: the
   * Shaper's own verb writes the link, and the capture's stage is read back out
   * of it. This is the join the stage unit tests cannot make — that
   * `land_on_work_item`'s route and `factsFor` are talking about the same field.
   */
  it("reports landed, naming the existing Todo, once the capture records where it went", async () => {
    const existing = workItems.createWorkItem({
      title: "Collapsed rail scrolls under the header on mobile",
      source: "session",
      sourceRef: "session:someone-else:6cd126d21e70",
      createdBy: "todo-shaper",
      department: "platform",
    });
    const started = await call("POST", "/api/todo-captures", { text: "the closed rail scrolls under the header on mobile" });
    const captureId = started.body.captureId as string;

    const landing = await call("POST", `/api/work-items/${existing.id}/capture-landing`, {}, asSession(captureId));
    expect(landing.status).toBe(200);

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.body).toMatchObject({
      stage: "landed",
      workItemId: existing.id,
      workItemTitle: "Collapsed rail scrolls under the header on mobile",
      routedTo: null,
      error: null,
    });
  });

  it("404s a landing on a Todo that is not there, without linking anything", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture with nowhere to land" });
    const captureId = started.body.captureId as string;

    const landing = await call("POST", "/api/work-items/TSK-99999/capture-landing", {}, asSession(captureId));

    expect(landing.status).toBe(404);
    expect((await call("GET", `/api/todo-captures/${captureId}`)).body.stage).not.toBe("landed");
  });

  it("surfaces every Todo one capture made rather than hiding the extras", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture that misbehaves" });
    const captureId = started.body.captureId as string;
    const first = workItems.createWorkItem({
      title: "First", source: "session", sourceRef: `session:${captureId}:6cd126d21e63`, createdBy: "todo-shaper",
    });
    const second = workItems.createWorkItem({
      title: "Second", source: "session", sourceRef: `session:${captureId}:6cd126d21e64`, createdBy: "todo-shaper",
    });

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.body.workItemId).toBe(first.id);
    expect(response.body.extraWorkItemIds).toEqual([second.id]);
  });

  // The live run's lesson, pinned. The route used to look for
  // `createdBy: session:<id>` — which the Shaper never writes, because
  // `createdBy` records the EMPLOYEE. A capture whose Todo was real then
  // reported "ended without creating a Todo". Provenance lives in `sourceRef`.
  it("ignores a Todo made by a DIFFERENT capture of the same employee", async () => {
    const mine = await call("POST", "/api/todo-captures", { text: "my capture" });
    const theirs = await call("POST", "/api/todo-captures", { text: "someone else's capture" });

    workItems.createWorkItem({
      title: "Belongs to the other capture",
      source: "session",
      sourceRef: `session:${theirs.body.captureId}:6cd126d21e65`,
      createdBy: "todo-shaper",
    });

    const response = await call("GET", `/api/todo-captures/${mine.body.captureId}`);

    expect(response.body.workItemId).toBeNull();
    expect(response.body.stage).toBe("starting");
  });

  // Acceptance (d) has two halves and the live run only had one: the strip
  // quoted the gateway's reason while the gateway log said nothing, so a
  // refusal was undiagnosable the moment the browser tab closed.
  it("writes every pre-spawn refusal to the gateway log, not only to the response", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { setJinnAttachGate } = await import("../../mcp/attachment.js");
    setJinnAttachGate({ ok: false, reason: "mcp.gateway.enabled: false (global kill switch)" });

    try {
      const response = await call("POST", "/api/todo-captures", { text: "this capture cannot be shaped" });

      expect(response.status).toBe(409);
      const logged = warn.mock.calls.map((args) => String(args[0])).join("\n");
      expect(logged).toContain("Quick capture refused (409)");
      expect(logged).toContain("mcp.gateway.enabled: false (global kill switch)");
      // The operator and the log read the same sentence.
      expect(logged).toContain(response.body.error);
    } finally {
      setJinnAttachGate({ ok: true });
      warn.mockRestore();
    }
  });

  // The other half of the same acceptance, and the one the refusal test cannot
  // reach: a capture that STARTED and then died mid-pipeline. Its reason is
  // derived rather than thrown, so nothing on the refusal path ever writes it,
  // and a killed capture used to leave the gateway log completely silent.
  it("writes a terminal failure to the gateway log once, not only to the response", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture killed mid-pipeline" });
    const captureId = started.body.captureId as string;
    registry.updateSession(captureId, { status: "interrupted", lastError: "Interrupted by user" });

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const response = await call("GET", `/api/todo-captures/${captureId}`);

      expect(response.body.stage).toBe("failed");
      const logged = warn.mock.calls.map((args) => String(args[0])).join("\n");
      expect(logged).toContain(captureId);
      expect(logged).toContain("Interrupted by user");
      // The operator and the log read the same sentence.
      expect(logged).toContain(response.body.error);

      // Polled again, the same failure is not written again: the log records
      // what changed, and a strip left open would otherwise fill it.
      warn.mockClear();
      await call("GET", `/api/todo-captures/${captureId}`);
      expect(warn.mock.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
