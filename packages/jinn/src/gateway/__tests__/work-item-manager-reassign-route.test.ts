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
writeEmployee("sub-lead", "senior", "boss");
writeEmployee("sub-report", "employee", "sub-lead");

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
async function assignedChild(owner: string, report: string, tag: string, rootAssignee: string | null = owner) {
  const root = workItems.createWorkItem({
    title: `root of ${tag}`,
    ...(rootAssignee ? { assignee: rootAssignee, status: "executing" as const } : {}),
  });
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
  ["a root owner who is also a manager over its report", "mgr", "mgr-report"],
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

  it("does not give a session linked to an operator-owned root standing over its children", async () => {
    const { child } = await assignedChild("peer-owner", "peer-report", "operator-root", "@operator");
    const linked = sessionOf("outsider", "operator-root-linked");
    workItems.linkSession(child.rootId, linked.id, `session:${linked.id}`, "review");
    const response = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(linked.id));
    expect(response.status).toBe(403);
  });

  it("does not give a session linked to an unassigned root standing over its children", async () => {
    const { child } = await assignedChild("peer-owner", "peer-report", "unassigned-root", null);
    const linked = sessionOf("outsider", "unassigned-root-linked");
    workItems.linkSession(child.rootId, linked.id, `session:${linked.id}`, "execute");
    const response = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(linked.id));
    expect(response.status).toBe(403);
  });
});

describe("a manager who does not own the root", () => {
  it("keeps standing over a Todo assigned to a report it manages", async () => {
    const root = workItems.createWorkItem({ title: "root of the manager case", assignee: "outsider", status: "executing" });
    const child = workItems.createWorkItem({ title: "assigned below the manager", parentId: root.id, assignee: "mgr-report" });
    const session = sessionOf("mgr", "manager-not-root-owner");
    const response = await call("POST", `/api/work-items/${child.id}/assign`, { assignee: "mgr" }, callerHeaders(session.id));
    expect(response.status).toBe(200);
  });
});

describe("a Todo handed down two levels", () => {
  it("leaves the middle assignee able to dispatch the grandchild it assigned", async () => {
    const { child } = await assignedChild("lead", "sub-lead", "grandchild");
    const creator = sessionOf("sub-lead", "grandchild-create");
    const grandchild = workItems.createWorkItem({
      title: "grandchild",
      parentId: child.id,
      source: "session",
      sourceRef: `session:${creator.id}:idempotency:grandchild`,
      createdBy: `session:${creator.id}`,
    });
    const session = sessionOf("sub-lead", "grandchild-assign");
    const assigned = await call("POST", `/api/work-items/${grandchild.id}/assign`, { assignee: "sub-report" }, callerHeaders(session.id));
    expect(assigned.status).toBe(200);

    const dispatched = await call("POST", `/api/work-items/${grandchild.id}/dispatch`, {}, callerHeaders(session.id));
    expect(dispatched.body.error).toBeUndefined();
    expect(dispatched.status).toBe(201);
  });
});

describe("a root nobody is assigned to", () => {
  /** An unassigned root made by a session of `creator`, with a child assigned to `peer-report`. */
  function unassignedRootBy(creator: string, tag: string, prefix: "session" | "delegate" = "session") {
    const maker = sessionOf(creator, `${tag}-maker`);
    const root = workItems.createWorkItem({
      title: `unassigned root of ${tag}`,
      source: "session",
      sourceRef: `${prefix}:${maker.id}:idempotency:${tag}`,
      createdBy: `session:${maker.id}`,
    });
    const child = workItems.createWorkItem({ title: `child of ${tag}`, parentId: root.id, assignee: "peer-report" });
    return { root, child };
  }

  it.each(["session", "delegate"] as const)("belongs to the employee whose session made it (%s source)", async (prefix) => {
    const { child } = unassignedRootBy("lead", `creator-${prefix}`, prefix);
    const creator = sessionOf("lead", `creator-${prefix}-later`);
    const stranger = sessionOf("outsider", `creator-${prefix}-stranger`);

    const refused = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(stranger.id));
    expect(refused.status).toBe(403);
    const dispatched = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(creator.id));
    expect(dispatched.body.error).toBeUndefined();
    expect(dispatched.status).toBe(201);
  });

  it("does not make a Dispatcher the owner, so its own hand-off rules still decide", async () => {
    const { child } = unassignedRootBy("todo-dispatcher", "dispatcher-made");
    const dispatcher = sessionOf("todo-dispatcher", "dispatcher-made-other");

    const response = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(dispatcher.id));
    expect(response.status).toBe(403);
  });
});

describe("claiming a parent", () => {
  /** An unassigned backlog parent, made by a session of `creator` or by the operator, with one open child. */
  function parentWithChild(tag: string, creator: string | null, childAssignee: string, childStatus: "backlog" | "executing" = "executing") {
    const maker = creator ? sessionOf(creator, `${tag}-maker`) : null;
    const root = workItems.createWorkItem({
      title: `parent of ${tag}`,
      ...(maker ? { source: "session" as const, sourceRef: `session:${maker.id}:idempotency:${tag}`, createdBy: `session:${maker.id}` } : {}),
    });
    const child = workItems.createWorkItem({ title: `child of ${tag}`, parentId: root.id, assignee: childAssignee, status: childStatus });
    return { root, child };
  }

  it("refuses a self-claim of an operator-made parent by someone with no standing over its open child", async () => {
    const { root, child } = parentWithChild("claim-operator", null, "peer-report");
    const stranger = sessionOf("outsider", "claim-operator-stranger");

    const claim = await call("POST", `/api/work-items/${root.id}/assign`, { assignee: "outsider" }, callerHeaders(stranger.id));
    expect(claim.status).toBe(403);
    expect(claim.body.error).toContain(child.id);
    expect(workItems.getWorkItem(root.id)?.assignee).toBeNull();

    const take = await call("POST", `/api/work-items/${child.id}/assign`, { assignee: "outsider" }, callerHeaders(stranger.id));
    expect(take.status).toBe(403);
    expect(workItems.getWorkItem(child.id)?.assignee).toBe("peer-report");
  });

  it("refuses a self-claim of another employee's parent, and leaves the creator its standing", async () => {
    const { root, child } = parentWithChild("claim-creator", "lead", "lead-report", "backlog");
    const stranger = sessionOf("outsider", "claim-creator-stranger");

    const claim = await call("POST", `/api/work-items/${root.id}/assign`, { assignee: "outsider" }, callerHeaders(stranger.id));
    expect(claim.status).toBe(403);
    const take = await call("POST", `/api/work-items/${child.id}/assign`, { assignee: "outsider" }, callerHeaders(stranger.id));
    expect(take.status).toBe(403);

    const lead = sessionOf("lead", "claim-creator-lead");
    const dispatched = await call("POST", `/api/work-items/${child.id}/dispatch`, {}, callerHeaders(lead.id));
    expect(dispatched.body.error).toBeUndefined();
    expect(dispatched.status).toBe(201);
  });

  it("refuses a session linked to an unassigned parent claiming it over someone else's open child", async () => {
    const { root } = parentWithChild("claim-linked", null, "peer-report");
    const linked = sessionOf("outsider", "claim-linked-session");
    workItems.linkSession(root.id, linked.id, `session:${linked.id}`, "review");

    const claim = await call("POST", `/api/work-items/${root.id}/assign`, { assignee: "outsider" }, callerHeaders(linked.id));
    expect(claim.status).toBe(403);
  });

  it("lets the parent's creator claim it and then reassign its child", async () => {
    const { root, child } = parentWithChild("claim-own", "lead", "lead-report", "backlog");
    const lead = sessionOf("lead", "claim-own-lead");

    const claim = await call("POST", `/api/work-items/${root.id}/assign`, { assignee: "lead" }, callerHeaders(lead.id));
    expect(claim.body.error).toBeUndefined();
    expect(claim.status).toBe(200);
    const reassign = await call("POST", `/api/work-items/${child.id}/assign`, { assignee: "lead" }, callerHeaders(lead.id));
    expect(reassign.status).toBe(200);
  });

  it("still lets anyone claim an unassigned Todo with nothing open below it", async () => {
    const leaf = workItems.createWorkItem({ title: "unclaimed leaf" });
    const parent = workItems.createWorkItem({ title: "parent of finished work" });
    workItems.createWorkItem({ title: "finished child", parentId: parent.id, assignee: "peer-report", status: "done" });
    const stranger = sessionOf("outsider", "claim-free");

    for (const id of [leaf.id, parent.id]) {
      const claim = await call("POST", `/api/work-items/${id}/assign`, { assignee: "outsider" }, callerHeaders(stranger.id));
      expect(claim.body.error, id).toBeUndefined();
      expect(claim.status, id).toBe(200);
    }
  });

  it("lets the operator assign a parent to anyone", async () => {
    const { root } = parentWithChild("claim-by-operator", null, "peer-report");
    const response = await call("POST", `/api/work-items/${root.id}/assign`, { assignee: "outsider" });
    expect(response.body.error).toBeUndefined();
    expect(response.status).toBe(200);
  });
});

describe("delegating a parent", () => {
  const delegate = (id: string, employee: string, sessionId: string) =>
    call("POST", "/api/delegations", { employee, task: "take it", workItemId: id }, callerHeaders(sessionId));

  it("refuses a session linked to an unassigned parent handing it to anyone over someone else's open child", async () => {
    const root = workItems.createWorkItem({ title: "linked umbrella" });
    const child = workItems.createWorkItem({ title: "linked umbrella child", parentId: root.id, assignee: "peer-report", status: "executing" });
    const linked = sessionOf("outsider", "delegate-linked");
    workItems.linkSession(root.id, linked.id, `session:${linked.id}`, "consult");

    for (const [caller, employee] of [[sessionOf("outsider", "delegate-linked-other").id, "outsider"], [linked.id, "sub-lead"]] as const) {
      const response = await delegate(root.id, employee, caller);
      expect(response.status, employee).toBe(403);
      expect(response.body.error, employee).toContain(child.id);
    }
    expect(workItems.getWorkItem(root.id)?.assignee).toBeNull();
  });

  it("refuses the creating session once the parent belongs to someone else", async () => {
    const maker = sessionOf("outsider", "delegate-moved-maker");
    const root = workItems.createWorkItem({
      title: "parent given away",
      source: "session",
      sourceRef: `session:${maker.id}:idempotency:delegate-moved`,
      createdBy: `session:${maker.id}`,
    });
    expect((await call("POST", `/api/work-items/${root.id}/assign`, { assignee: "lead" })).status).toBe(200);
    workItems.createWorkItem({ title: "lead's split", parentId: root.id, assignee: "lead-report", status: "executing" });

    const response = await delegate(root.id, "outsider", maker.id);
    expect(response.status).toBe(403);
    expect(workItems.getWorkItem(root.id)?.assignee).toBe("lead");
  });

  it("lets the parent's owner delegate it over sub-tasks it handed out", async () => {
    const root = workItems.createWorkItem({ title: "lead's parent", assignee: "lead", status: "executing" });
    workItems.createWorkItem({ title: "lead's handed-out child", parentId: root.id, assignee: "lead-report", status: "executing" });

    const response = await delegate(root.id, "sub-lead", sessionOf("lead", "delegate-owner").id);
    expect(response.body.error).toBeUndefined();
    expect(response.status).toBe(201);
    expect(workItems.getWorkItem(root.id)?.assignee).toBe("sub-lead");
  });
});
