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
 * Who may re-parent a Todo as an employee. Moving a Todo needs standing over it
 * and over its new parent, except for the two attaches that undo or complete a
 * detach: putting a detached Todo back under the parent it left, and a parent's
 * owner taking in a root Todo nobody is assigned to.
 */

function writeEmployee(name: string) {
  fs.writeFileSync(
    path.join(home, "org", `${name}.yaml`),
    [
      `name: ${name}`,
      `displayName: ${name}`,
      "department: platform",
      "rank: senior",
      "engine: codex",
      "model: gpt-5.6-sol",
      "reportsTo: boss",
      `persona: ${name} for the reparent authority tests`,
      "",
    ].join("\n"),
  );
}
fs.writeFileSync(
  path.join(home, "org", "boss.yaml"),
  ["name: boss", "displayName: boss", "department: platform", "rank: executive", "engine: codex", "model: gpt-5.6-sol", "persona: boss", ""].join("\n"),
);
// Peers under one boss, with no reporting line between them.
for (const name of ["child-owner", "parent-owner", "other-parent-owner", "outsider"]) writeEmployee(name);

let registry: Registry;
let workItems: WorkItems;

function headersFor(employee: string, tag: string): Record<string, string> {
  const session = registry.createSession({ engine: "codex", source: "web", sourceRef: `reparent-authority:${tag}`, connector: "web", employee, prompt: "work" });
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id),
  };
}

const move = (id: string, parentId: string | null, employee: string, tag: string) =>
  call("PUT", `/api/work-items/${id}/parent`, { parentId }, headersFor(employee, tag));

/** A parent held by `parent-owner` with one child held by `child-owner`, who owns no Todo above it. */
function family(assignChild: string | null = "child-owner") {
  const parent = workItems.createWorkItem({ title: "parent", assignee: "parent-owner", status: "executing" });
  const child = workItems.createWorkItem({ title: "child", parentId: parent.id, ...(assignChild ? { assignee: assignChild } : {}) });
  return { parent, child };
}

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("re-attaching a detached Todo", () => {
  it("lets the employee who detached a child put it back under the parent it left", async () => {
    const { parent, child } = family();
    expect((await move(child.id, null, "child-owner", "detach")).status).toBe(200);
    const back = await move(child.id, parent.id, "child-owner", "reattach");
    expect(back.body.error).toBeUndefined();
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ parentId: parent.id, rootId: parent.id, depth: 1, changed: true });
  });

  it("lets the same employee detach and re-attach a second time", async () => {
    const { parent, child } = family();
    for (const round of ["one", "two"]) {
      expect((await move(child.id, null, "child-owner", `detach-${round}`)).status).toBe(200);
      expect((await move(child.id, parent.id, "child-owner", `attach-${round}`)).status).toBe(200);
    }
    expect(workItems.getWorkItem(child.id)).toMatchObject({ parentId: parent.id });
  });

  it("lets a parent's owner take in an unassigned detached child", async () => {
    const { parent, child } = family(null);
    expect((await call("PUT", `/api/work-items/${child.id}/parent`, { parentId: null })).status).toBe(200);
    const taken = await move(child.id, parent.id, "parent-owner", "adopt");
    expect(taken.body.error).toBeUndefined();
    expect(taken.status).toBe(200);
    expect(workItems.getWorkItem(child.id)).toMatchObject({ parentId: parent.id, rootId: parent.id });
  });

  it("still lets the owner of both ends attach", async () => {
    const parent = workItems.createWorkItem({ title: "parent", assignee: "parent-owner", status: "executing" });
    const loose = workItems.createWorkItem({ title: "loose", assignee: "parent-owner" });
    expect((await move(loose.id, parent.id, "parent-owner", "both")).status).toBe(200);
  });
});

describe("re-parenting stays bounded", () => {
  it("refuses an unrelated employee, on a detached child and on an attached one", async () => {
    const { parent, child } = family();
    const attached = await move(child.id, null, "outsider", "outsider-detach");
    expect(attached.status).toBe(403);
    expect(attached.body.error).toContain(`does not own Todo ${child.id}`);
    expect((await move(child.id, null, "child-owner", "detach")).status).toBe(200);
    const attach = await move(child.id, parent.id, "outsider", "outsider-attach");
    expect(attach.status).toBe(403);
    expect(workItems.getWorkItem(child.id)).toMatchObject({ parentId: null });
  });

  it("does not let the child's owner attach it to a parent it did not leave", async () => {
    const { child } = family();
    const elsewhere = workItems.createWorkItem({ title: "elsewhere", assignee: "other-parent-owner", status: "executing" });
    expect((await move(child.id, null, "child-owner", "detach")).status).toBe(200);
    const refused = await move(child.id, elsewhere.id, "child-owner", "attach-elsewhere");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain(`does not own Todo ${elsewhere.id}`);
    expect(workItems.getWorkItem(child.id)).toMatchObject({ parentId: null });
  });

  it("does not let a Todo that was never under a parent be hung under one it does not hold", async () => {
    const parent = workItems.createWorkItem({ title: "parent", assignee: "parent-owner", status: "executing" });
    const loose = workItems.createWorkItem({ title: "loose", assignee: "child-owner" });
    expect((await move(loose.id, parent.id, "child-owner", "never-left")).status).toBe(403);
  });

  it("forgets a detach once the Todo has been moved under another parent and out again", async () => {
    const { parent, child } = family();
    const second = workItems.createWorkItem({ title: "second", assignee: "child-owner", status: "executing" });
    expect((await move(child.id, null, "child-owner", "detach")).status).toBe(200);
    expect((await move(child.id, second.id, "child-owner", "to-second")).status).toBe(200);
    expect((await move(child.id, null, "child-owner", "out-of-second")).status).toBe(200);
    expect((await move(child.id, parent.id, "child-owner", "to-first")).status).toBe(403);
  });

  it("does not restore a Todo into a parent it is still attached below another one", async () => {
    const { parent, child } = family();
    const second = workItems.createWorkItem({ title: "second", assignee: "child-owner", status: "executing" });
    expect((await move(child.id, null, "child-owner", "detach")).status).toBe(200);
    expect((await move(child.id, second.id, "child-owner", "to-second")).status).toBe(200);
    expect((await move(child.id, parent.id, "child-owner", "straight-back")).status).toBe(403);
  });

  it("does not let a parent's owner take another employee's child", async () => {
    const { parent, child } = family();
    expect((await call("PUT", `/api/work-items/${child.id}/parent`, { parentId: null })).status).toBe(200);
    const refused = await move(child.id, parent.id, "parent-owner", "take-assigned");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain(`does not own Todo ${child.id}`);
  });

  it("does not let a parent's owner take an unassigned Todo that still sits under another parent", async () => {
    const { child } = family(null);
    const mine = workItems.createWorkItem({ title: "mine", assignee: "other-parent-owner", status: "executing" });
    expect((await move(child.id, mine.id, "other-parent-owner", "pull-from-tree")).status).toBe(403);
    expect(workItems.getWorkItem(child.id)).not.toMatchObject({ parentId: mine.id });
  });

  it("does not let a parent's owner take an unassigned Todo with open work below it that is not theirs", async () => {
    const { parent, child } = family(null);
    workItems.createWorkItem({ title: "grandchild", parentId: child.id, assignee: "child-owner", status: "executing" });
    expect((await call("PUT", `/api/work-items/${child.id}/parent`, { parentId: null })).status).toBe(200);
    const refused = await move(child.id, parent.id, "parent-owner", "adopt-subtree");
    expect(refused.status).toBe(403);
    expect(workItems.getWorkItem(child.id)).toMatchObject({ parentId: null });
  });

  it("still refuses a cycle and a Todo as its own parent", async () => {
    const top = workItems.createWorkItem({ title: "top", assignee: "parent-owner", status: "executing" });
    const mid = workItems.createWorkItem({ title: "mid", parentId: top.id, assignee: "parent-owner" });
    const cyc = await move(top.id, mid.id, "parent-owner", "cycle");
    expect(cyc.status).toBe(400);
    expect(cyc.body.error).toContain("already beneath it");
    const self = await move(top.id, top.id, "parent-owner", "self");
    expect(self.status).toBe(400);
    expect(self.body.error).toContain("its own parent");
  });

  it("still refuses a cycle for a restore", async () => {
    const top = workItems.createWorkItem({ title: "top", assignee: "parent-owner", status: "executing" });
    const mid = workItems.createWorkItem({ title: "mid", parentId: top.id, assignee: "parent-owner" });
    expect((await move(mid.id, null, "parent-owner", "detach-mid")).status).toBe(200);
    expect((await move(top.id, mid.id, "parent-owner", "top-under-mid")).status).toBe(200);
    // mid was detached from top, but top now sits under mid: putting mid back would be a cycle.
    const cyc = await move(mid.id, top.id, "parent-owner", "mid-back");
    expect(cyc.status).toBe(400);
    expect(cyc.body.error).toContain("already beneath it");
  });
});
