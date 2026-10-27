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
 * A lead who hands a sub-task to a report keeps standing over it. Assigning
 * moves the Todo's owner to the assignee, so the lead has to hold the standing
 * some other way: by owning the Todo's root, or by managing the assignee.
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
      `persona: ${name} for the reassign tests`,
      "",
    ].join("\n"),
  );
}
// boss > mgr > mgr-report; boss > lead > lead-report;
// boss > peer-owner and boss > peer-report, with no reporting line between them.
writeEmployee("boss", "executive");
writeEmployee("mgr", "manager", "boss");
writeEmployee("mgr-report", "employee", "mgr");
writeEmployee("lead", "senior", "boss");
writeEmployee("lead-report", "employee", "lead");
writeEmployee("peer-owner", "senior", "boss");
writeEmployee("peer-report", "employee", "boss");
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
  return registry.createSession({ engine: "codex", source: "web", sourceRef: `reassign:${tag}`, connector: "web", employee, prompt: "work" });
}

/**
 * A root `owner` holds and a backlog child under it, made by one session of the
 * owner and assigned to `report` by another, as a lead does across turns.
 */
async function assignedChild(owner: string, report: string, tag: string) {
  const root = workItems.createWorkItem({ title: `root of ${tag}`, assignee: owner, status: "executing" });
  const creator = sessionOf(owner, `${tag}-create`);
  const child = workItems.createWorkItem({
    title: `child of ${tag}`,
    parentId: root.id,
    source: "session",
    sourceRef: `session:${creator.id}:idempotency:${tag}`,
    createdBy: `session:${creator.id}`,
  });
  const session = sessionOf(owner, `${tag}-assign`);
  const assigned = await call("POST", `/api/work-items/${child.id}/assign`, { assignee: report }, callerHeaders(session.id));
  expect(assigned.status).toBe(200);
  return { root, child, session };
}

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe.each([
  ["a manager over its report", "mgr", "mgr-report"],
  ["a root owner who leads its report", "lead", "lead-report"],
  ["a root owner with no reporting line to the assignee", "peer-owner", "peer-report"],
])("%s, after assigning a child", (_label, owner, report) => {
  it("can dispatch it", async () => {
    const { child, session } = await assignedChild(owner, report, `${owner}-dispatch`);
    const response = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(session.id));
    expect(response.body.error).toBeUndefined();
    expect(response.status).toBe(201);
  });

  it("can reassign it", async () => {
    const { child, session } = await assignedChild(owner, report, `${owner}-reassign`);
    const response = await call("POST", `/api/work-items/${child.id}/assign`, { assignee: owner }, callerHeaders(session.id));
    expect(response.body.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.body.workItem.assignee).toBe(owner);
  });

  it("can delegate it", async () => {
    const { child, session } = await assignedChild(owner, report, `${owner}-delegate`);
    const response = await call(
      "POST",
      "/api/delegations",
      { employee: report, task: "carry on", workItemId: child.id },
      callerHeaders(session.id),
    );
    expect(response.body.error).toBeUndefined();
    expect(response.status).toBe(201);
    expect(registry.getSession(response.body.sessionId)).toMatchObject({ employee: report });
  });
});

describe("standing over an assigned child stays bounded", () => {
  it("refuses an employee who neither owns the root nor manages the assignee", async () => {
    const { child } = await assignedChild("peer-owner", "peer-report", "bounded");
    const stranger = sessionOf("outsider", "bounded-stranger");

    for (const [route, body] of [
      [`/api/work-items/${child.id}/dispatch`, {}],
      [`/api/work-items/${child.id}/assign`, { assignee: "outsider" }],
      ["/api/delegations", { employee: "peer-report", task: "carry on", workItemId: child.id }],
    ] as const) {
      const response = await call("POST", route, body, callerHeaders(stranger.id));
      expect(response.status, route).toBe(403);
    }
    expect(workItems.getWorkItem(child.id)?.assignee).toBe("peer-report");
  });

  it("does not extend a root owner's standing to a different root's children", async () => {
    const { child } = await assignedChild("peer-owner", "peer-report", "other-root");
    const otherOwner = sessionOf("lead", "other-root-lead");
    workItems.createWorkItem({ title: "lead's own root", assignee: "lead", status: "executing" });

    const response = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(otherOwner.id));
    expect(response.status).toBe(403);
  });
});
