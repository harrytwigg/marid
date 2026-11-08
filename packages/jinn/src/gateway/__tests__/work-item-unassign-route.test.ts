import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { call, home, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * Giving a Todo to someone and taking it back are the same governance decision:
 * whoever may assign a Todo may also clear its assignee, with `@unassigned` or an
 * explicit null, and nobody else may.
 */

function writeEmployee(name: string, rank: string, reportsTo?: string) {
  fs.writeFileSync(
    path.join(home, "org", `${name}.yaml`),
    [
      `name: ${name}`,
      `displayName: ${name}`,
      "department: platform",
      `rank: ${rank}`,
      "engine: codex",
      "model: gpt-5.6-sol",
      ...(reportsTo ? [`reportsTo: ${reportsTo}`] : []),
      `persona: ${name} for the unassign tests`,
      "",
    ].join("\n"),
  );
}
writeEmployee("boss", "executive");
writeEmployee("mgr", "manager", "boss");
writeEmployee("mgr-report", "employee", "mgr");
writeEmployee("holder", "senior", "boss");
writeEmployee("outsider", "senior", "boss");

let registry: Registry;
let workItems: WorkItems;

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

function sessionOf(employee: string, tag: string) {
  return registry.createSession({ engine: "codex", source: "web", sourceRef: `unassign:${tag}`, connector: "web", employee, prompt: "work" });
}

function assignedTodo(assignee: string, title: string) {
  return workItems.createWorkItem({ title, assignee, status: "backlog" });
}

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("POST /api/work-items/:id/assign clears the assignee", () => {
  it.each([
    ["@unassigned", "@unassigned"],
    ["an explicit null", null],
  ])("lets the owner clear it with %s", async (_label, value) => {
    const item = assignedTodo("holder", `owner clears with ${String(value)}`);
    const session = sessionOf("holder", `owner-${String(value)}`);

    const response = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: value }, callerHeaders(session.id));

    expect(response.body.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.body.workItem.assignee).toBeNull();
    expect(response.body.workItem.status).toBe("backlog");
    expect(workItems.getWorkItem(item.id)!.assignee).toBeNull();
    const listed = await call("GET", "/api/work-items?assignee=%40unassigned&limit=200");
    expect((listed.body.workItems as Array<{ id: string }>).map((row) => row.id)).toContain(item.id);
  });

  it("lets the operator clear it", async () => {
    const item = assignedTodo("holder", "operator clears");
    const response = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "@unassigned" });
    expect(response.status).toBe(200);
    expect(response.body.workItem.assignee).toBeNull();
  });

  it("lets a manager of the owner clear it", async () => {
    const item = assignedTodo("mgr-report", "manager clears");
    const session = sessionOf("mgr", "manager-clears");
    const response = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "@unassigned" }, callerHeaders(session.id));
    expect(response.status).toBe(200);
    expect(response.body.workItem.assignee).toBeNull();
  });

  it("refuses an unrelated employee and leaves the assignee alone", async () => {
    const item = assignedTodo("holder", "stranger cannot clear");
    const stranger = sessionOf("outsider", "stranger");
    for (const value of ["@unassigned", null]) {
      const response = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: value }, callerHeaders(stranger.id));
      expect(response.status, String(value)).toBe(403);
    }
    expect(workItems.getWorkItem(item.id)!.assignee).toBe("holder");
  });

  it("treats clearing an unassigned Todo as a no-op", async () => {
    const item = workItems.createWorkItem({ title: "already unassigned" });
    const before = workItems.getWorkItem(item.id)!;
    const response = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "@unassigned" });
    expect(response.status).toBe(200);
    expect(response.body.workItem.assignee).toBeNull();
    expect(response.body.workItem.version).toBe(before.version);
  });

  it("still refuses a missing or empty assignee", async () => {
    const closed = assignedTodo("holder", "empty assignee");
    const empty = await call("POST", `/api/work-items/${closed.id}/assign`, { assignee: "" });
    expect(empty.status).toBe(400);
    const missing = await call("POST", `/api/work-items/${closed.id}/assign`, {});
    expect(missing.status).toBe(400);
    expect(workItems.getWorkItem(closed.id)!.assignee).toBe("holder");
  });
});

describe("PATCH /api/work-items/:id keeps assignee on the operator pen", () => {
  it("refuses an employee clearing it with null", async () => {
    const item = assignedTodo("holder", "patch refused");
    const session = sessionOf("holder", "patch-null");
    const response = await call(
      "PATCH",
      `/api/work-items/${item.id}`,
      { assignee: null, expectedVersion: item.version },
      callerHeaders(session.id),
    );
    expect(response.status).toBe(403);
    expect(workItems.getWorkItem(item.id)!.assignee).toBe("holder");
  });

  it("still lets the operator clear it with null", async () => {
    const item = assignedTodo("holder", "patch operator");
    const response = await call("PATCH", `/api/work-items/${item.id}`, { assignee: null, expectedVersion: item.version });
    expect(response.status).toBe(200);
    expect(workItems.getWorkItem(item.id)!.assignee).toBeNull();
  });
});
