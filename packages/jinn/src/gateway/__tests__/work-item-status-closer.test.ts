import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { as, call, context, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";

/**
 * The closer lane, through the real `handleApiRequest`: an employee whose YAML says
 * `closeTodos: true` may move a Todo to `done` as itself, with a reason, and nothing
 * else. Who the operator granted it to is read from the live roster on every call.
 *
 *   engineering (open):        closer-dev (closeTodos), plain-dev
 *   side-project (scoped):     side-closer (closeTodos)
 */

type WorkItems = Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let workItems: WorkItems;
let refreshOrg: (config?: unknown) => unknown;
let listComments: typeof import("../../work-items/comments.js").listComments;
let listWorkItemEvents: typeof import("../../work-items/event-log.js").listWorkItemEvents;
let transition: typeof import("../../work-items/transitions.js").transition;

function writeEmployee(directory: string, name: string, extra: string[] = []): void {
  const file = path.join(home, "org", directory, `${name}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `name: ${name}`, `displayName: ${name}`, `department: ${directory}`, "rank: employee", "engine: claude", "model: opus", `persona: Works on ${directory}.`, ...extra, "",
  ].join("\n"));
}

const grant = ["closeTodos: true"];

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
  ({ refreshOrg } = await import("../org-registry.js") as unknown as { refreshOrg: (config?: unknown) => unknown });
  ({ listComments } = await import("../../work-items/comments.js"));
  ({ listWorkItemEvents } = await import("../../work-items/event-log.js"));
  ({ transition } = await import("../../work-items/transitions.js"));
  writeEmployee("engineering", "closer-dev", grant);
  writeEmployee("engineering", "plain-dev");
  writeEmployee("side-project", "side-closer", grant);
  refreshOrg(context.getConfig());
});

afterEach(() => {
  writeEmployee("engineering", "closer-dev", grant);
  refreshOrg(context.getConfig());
});

const closeBody = { status: "done", note: "PR merged and deployed" };
const statusOf = (id: string) => workItems.getWorkItem(id)?.status;
const reviewTodo = (title: string, extra: Record<string, unknown> = {}) => workItems.createWorkItem({ title, status: "in_review", ...extra });
const closeAs = async (employee: string, id: string, body: Record<string, unknown> = closeBody) =>
  as((await sessionOf(employee)).id)("POST", `/api/work-items/${id}/status`, body);

describe("an employee granted closeTodos", () => {
  it("closes an in_review Todo as itself: comment posted, actor and detail on the event", async () => {
    const item = reviewTodo("Ready to close");
    const session = await sessionOf("closer-dev");

    const res = await as(session.id)("POST", `/api/work-items/${item.id}/status`, closeBody);

    expect([res.status, res.body.workItem.status]).toEqual([200, "done"]);
    expect(statusOf(item.id)).toBe("done");
    const comments = listComments(item.id).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      body: "Closed as done by closer-dev. Reason: PR merged and deployed",
      author: "closer-dev",
      authorKind: "employee",
      sessionId: session.id,
    });
    const closeEvent = listWorkItemEvents(item.id).filter((event) => event.toStatus === "done").at(-1)!;
    expect(closeEvent.actor).toBe(`session:${session.id}`);
    expect(closeEvent.actor).not.toBe("operator");
    expect(closeEvent.detail).toMatchObject({ closeTodos: true, note: "PR merged and deployed", actorEmployee: "closer-dev" });
    expect(closeEvent.detail).not.toHaveProperty("operatorLane");
    expect(closeEvent.detail).not.toHaveProperty("asOperator");
  });

  it("refuses a close without the reason, and leaves the Todo where it was", async () => {
    const item = reviewTodo("No reason");
    for (const body of [{ status: "done" }, { status: "done", note: "   " }]) {
      const res = await closeAs("closer-dev", item.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/needs the reason in note/);
    }
    expect(statusOf(item.id)).toBe("in_review");
    expect(listComments(item.id).total).toBe(0);
  });

  it("does not cancel", async () => {
    const item = reviewTodo("Not cancellable");
    const res = await closeAs("closer-dev", item.id, { status: "cancelled", note: "no longer needed" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cancelling/);
    expect(statusOf(item.id)).toBe("in_review");
  });

  it("does not cascade over open descendants", async () => {
    const parent = reviewTodo("Parent of open work");
    const child = workItems.createWorkItem({ title: "Open child", parentId: parent.id, status: "executing" });
    const res = await closeAs("closer-dev", parent.id, { ...closeBody, cascade: true });
    expect([res.status, res.body.error]).toEqual([403, "closing a Todo's open descendants with it is an operator-surface decision"]);
    expect([statusOf(parent.id), statusOf(child.id)]).toEqual(["in_review", "executing"]);
  });

  it("does not reopen a closed Todo, nor re-close one", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const item = reviewTodo(`Already ${status}`);
      transition(item.id, status, "operator", { human: true });
      const reopen = await closeAs("closer-dev", item.id, { status: "backlog", note: "reopening" });
      expect(reopen.status).toBe(403);
      expect(reopen.body.error).toMatch(/reopening closed work is the operator's/);
      const again = await closeAs("closer-dev", item.id);
      expect(again.status).toBe(403);
      expect(again.body.error).toMatch(/already (done|cancelled); reopening closed work is the operator's/);
      expect(statusOf(item.id)).toBe(status);
      expect(listComments(item.id).total).toBe(0);
    }
  });

  it("moves everything else through the ordinary agent lane", async () => {
    const item = workItems.createWorkItem({ title: "Agent moves", status: "backlog" });
    const session = await sessionOf("closer-dev");
    const move = (status: string, note?: string) => as(session.id)("POST", `/api/work-items/${item.id}/status`, { status, ...(note ? { note } : {}) });

    expect((await move("executing")).status).toBe(200);
    // The in_review handoff keeps its summary rule: the closer's grant buys nothing here.
    expect((await move("in_review")).status).toBe(400);
    expect((await move("in_review", "ready")).status).toBe(200);
    // in_review → backlog is no agent move, grant or not.
    expect((await move("backlog")).status).toBe(403);
    expect(statusOf(item.id)).toBe("in_review");
  });

  it("is refused the self-review ban: a session that executed the Todo cannot close it", async () => {
    const item = reviewTodo("Executed by the closer");
    const session = await sessionOf("closer-dev");
    workItems.linkSession(item.id, session.id);

    const res = await as(session.id)("POST", `/api/work-items/${item.id}/status`, closeBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/executed work item .* cannot mark it done/);
    expect(statusOf(item.id)).toBe("in_review");
    expect(listComments(item.id).total).toBe(0);
  });

  it("still lets a reviewer session, linked as the reviewer, close it", async () => {
    const item = reviewTodo("Reviewed by the closer");
    const session = await sessionOf("closer-dev");
    workItems.linkSession(item.id, session.id, null, "review");

    const res = await as(session.id)("POST", `/api/work-items/${item.id}/status`, closeBody);

    expect([res.status, statusOf(item.id)]).toEqual([200, "done"]);
  });

  it("is held by the open-children gate", async () => {
    const parent = reviewTodo("Container with open work");
    workItems.createWorkItem({ title: "Open child", parentId: parent.id, status: "executing" });

    const res = await closeAs("closer-dev", parent.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/still has open children/);
    expect(statusOf(parent.id)).toBe("in_review");
    expect(listComments(parent.id).total).toBe(0);
  });

  it("stops closing on the next call once the operator revokes the grant", async () => {
    const first = reviewTodo("Closed while granted");
    const second = reviewTodo("Open when revoked");
    const session = await sessionOf("closer-dev");
    const post = (id: string) => as(session.id)("POST", `/api/work-items/${id}/status`, closeBody);

    expect((await post(first.id)).status).toBe(200);

    writeEmployee("engineering", "closer-dev");
    refreshOrg(context.getConfig());

    const refused = await post(second.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/operator's decision/);
    expect(statusOf(second.id)).toBe("in_review");
  });

  it("reads only a literal true as the grant", async () => {
    for (const value of ['"true"', "1", "yes", "'true'"]) {
      writeEmployee("engineering", "closer-dev", [`closeTodos: ${value}`]);
      refreshOrg(context.getConfig());
      const item = reviewTodo(`Grant spelled ${value}`);
      const res = await closeAs("closer-dev", item.id);
      expect([value, res.status]).toEqual([value, 403]);
    }
  });
});

describe("an employee without the grant", () => {
  it("is refused as today", async () => {
    const item = reviewTodo("Not theirs to close");
    const res = await closeAs("plain-dev", item.id);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/closing Todo .* is the operator's decision/);
    expect(statusOf(item.id)).toBe("in_review");
  });

  it("is refused a session with no employee at all", async () => {
    const item = reviewTodo("Employee-less caller");
    const res = await as((await sessionOf(null)).id)("POST", `/api/work-items/${item.id}/status`, closeBody);
    expect(res.status).toBe(403);
    expect(statusOf(item.id)).toBe("in_review");
  });

  it("cannot take a grant by claiming asOperator either", async () => {
    const item = reviewTodo("Claiming the coordinator");
    const res = await closeAs("closer-dev", item.id, { ...closeBody, asOperator: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/asOperator is reserved for the operator's coordinator session/);
    expect(statusOf(item.id)).toBe("in_review");
  });
});

describe("department scope", () => {
  it("holds a closer in a scoped department to its own department's Todos", async () => {
    const mine = workItems.createWorkItem({ title: "Mine", department: "side-project", status: "in_review" });
    const company = reviewTodo("Company Todo");
    const session = await sessionOf("side-closer");
    const scoped = as(session.id);

    const outside = await scoped("POST", `/api/work-items/${company.id}/status`, closeBody);
    expect(outside.status).toBe(404);
    expect(statusOf(company.id)).toBe("in_review");

    const inside = await scoped("POST", `/api/work-items/${mine.id}/status`, closeBody);
    expect([inside.status, statusOf(mine.id)]).toEqual([200, "done"]);
  });

  it("lets an open-department closer close a Todo in another department", async () => {
    const elsewhere = workItems.createWorkItem({ title: "Elsewhere", department: "engineering", status: "in_review" });
    const res = await closeAs("closer-dev", elsewhere.id);
    expect([res.status, statusOf(elsewhere.id)]).toEqual([200, "done"]);
  });
});

describe("what a closer's done leaves behind", () => {
  it("is not undone or flagged by the reconciler or the recovery sweep", async () => {
    const { reconcileActiveWorkItems } = await import("../../work-items/reconcile.js");
    const { sweepTodoRecovery } = await import("../../work-items/recovery-controller.js");
    const item = reviewTodo("Closed by a granted employee");
    const session = await sessionOf("closer-dev");
    expect((await as(session.id)("POST", `/api/work-items/${item.id}/status`, closeBody)).status).toBe(200);
    const before = workItems.getWorkItem(item.id)!;

    reconcileActiveWorkItems();
    sweepTodoRecovery({ mode: "auto", apply: () => {} } as never);
    reconcileActiveWorkItems();

    const after = workItems.getWorkItem(item.id)!;
    expect([after.status, after.version, after.closedAt]).toEqual([before.status, before.version, before.closedAt]);
    expect(listWorkItemEvents(item.id).filter((event) => event.toStatus !== null).map((event) => event.actor)).not.toContain("reconciler");
  });

});

describe("the grant is not writable through the API", () => {
  it("rejects a PATCH to the employee route that carries closeTodos, and writes nothing", async () => {
    const before = fs.readFileSync(path.join(home, "org", "engineering", "plain-dev.yaml"), "utf-8");
    for (const closeTodos of [true, false, "true"]) {
      const res = await call("PATCH", "/api/org/employees/plain-dev", { closeTodos });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown field\(s\): closeTodos/);
    }
    const mixed = await call("PATCH", "/api/org/employees/plain-dev", { displayName: "Renamed", closeTodos: true });
    expect(mixed.status).toBe(400);
    expect(fs.readFileSync(path.join(home, "org", "engineering", "plain-dev.yaml"), "utf-8")).toBe(before);
    const closeAttempt = await closeAs("plain-dev", reviewTodo("Still not granted").id);
    expect(closeAttempt.status).toBe(403);
  });

  it("keeps an existing grant through an unrelated PATCH", async () => {
    const res = await call("PATCH", "/api/org/employees/closer-dev", { displayName: "Closer Dev" });
    expect(res.status).toBe(200);
    expect(res.body.employee).toMatchObject({ displayName: "Closer Dev", closeTodos: true });
    const item = reviewTodo("Grant survives an edit");
    expect((await closeAs("closer-dev", item.id)).status).toBe(200);
  });

  it("returns the grant on the org reads, and only where it is true", async () => {
    const detail = await call("GET", "/api/org/employees/closer-dev");
    expect(detail.body).toMatchObject({ name: "closer-dev", closeTodos: true });
    const plain = await call("GET", "/api/org/employees/plain-dev");
    expect(plain.body.closeTodos ?? false).toBe(false);
    const org = await call("GET", "/api/org");
    const byName = new Map<string, { closeTodos?: boolean }>(org.body.employees.map((e: { name: string }) => [e.name, e]));
    expect(byName.get("closer-dev")?.closeTodos).toBe(true);
    expect(byName.get("plain-dev")?.closeTodos ?? false).toBe(false);
  });
});
