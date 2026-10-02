import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { call, startRouteHarness, stopRouteHarness, type Registry } from "./todo-route-harness.js";

/**
 * The Todo's explicit auto-start opt-out (`autoStart` on its dispatch config),
 * as the routes write and validate it.
 */

let registry: Registry;

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

function workerSession(sourceRef: string) {
  return registry.createSession({
    engine: "codex", source: "web", sourceRef, connector: "web", employee: "route-worker", prompt: "work",
  });
}

beforeAll(async () => { ({ registry } = await startRouteHarness()); });
afterAll(stopRouteHarness);

describe("autoStart on the Todo's dispatch config", () => {
  it("is written at creation, read on the Todo and on the assignment event, and refuses a non-boolean", async () => {
    const session = workerSession("gen67-create-opt-out");
    const refused = await call("POST", "/api/work-items", { title: "bad flag", autoStart: "no" }, callerHeaders(session.id));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("autoStart");

    const created = await call("POST", "/api/work-items", { title: "no auto-start", autoStart: false }, callerHeaders(session.id));
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    expect((await call("GET", `/api/work-items/${id}`)).body.dispatchConfig).toMatchObject({ autoStart: false, skills: [] });

    expect((await call("POST", `/api/work-items/${id}/assign`, { assignee: "route-worker" })).status).toBe(200);
  });

  it("stores nothing for autoStart: true at creation, and is settable afterwards through dispatch-config", async () => {
    const created = await call("POST", "/api/work-items", { title: "default auto-start", autoStart: true });
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    expect((await call("GET", `/api/work-items/${id}`)).body.dispatchConfig).toBeNull();

    expect((await call("PUT", `/api/work-items/${id}/dispatch-config`, { autoStart: "false" })).status).toBe(400);
    const optedOut = await call("PUT", `/api/work-items/${id}/dispatch-config`, { autoStart: false });
    expect(optedOut.status).toBe(200);
    expect(optedOut.body.dispatchConfig).toMatchObject({ autoStart: false });
    const restored = await call("PUT", `/api/work-items/${id}/dispatch-config`, { autoStart: true });
    expect(restored.body.dispatchConfig).toMatchObject({ autoStart: true });
  });
});
