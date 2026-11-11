import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let viewer: Member;
let collab: Member;
let owner: Member;
let elsewhere: Member;
let store: typeof import("../../work-items/store.js");
let users: typeof import("../users.js");

const events = (id: string) => store.listWorkItemEvents(id).filter((event) => event.kind === "person_changed");
const storedRow = (id: string) => h.db.prepare("SELECT * FROM todo_people WHERE todo_id = ?").get(id) as { person: string; set_by: string } | undefined;
const opsTodo = (extra: Record<string, unknown> = {}) => store.createWorkItem({ title: "A Todo", department: "ops", ...extra });
const putPerson = (m: Member, id: string, person: unknown) => h.as(m, "PUT", `/api/member/todos/${id}/person`, { person });
const operatorSet = (id: string, humanAssignee: unknown) =>
  h.operator("PATCH", `/api/work-items/${id}`, { humanAssignee, expectedVersion: store.getWorkItem(id)!.version });

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  users = await import("../users.js");
  viewer = await h.join("viewer@example.test", "viewer", "ops", "Vic Viewer");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  owner = await h.join("owner@example.test", "owner", "ops", "Olive Owner");
  elsewhere = await h.join("design@example.test", "collaborator", "design", "Dee Designer");
}, 60_000);
afterAll(async () => { await h.close(); });

describe("humanAssignee on the store row", () => {
  it("is null for a Todo with neither a person nor an operator assignee, and for one assigned to an agent", () => {
    expect(opsTodo().humanAssignee).toBeNull();
    const agent = opsTodo();
    store.updateWorkItem(agent.id, { assignee: "alice" });
    expect(store.getWorkItem(agent.id)!.humanAssignee).toBeNull();
  });

  it("reads the operator for a legacy Todo assigned to them, with no row behind it", () => {
    const legacy = opsTodo();
    store.updateWorkItem(legacy.id, { assignee: "@operator" });
    expect(store.getWorkItem(legacy.id)!.humanAssignee).toBe("@operator");
    expect(storedRow(legacy.id)).toBeUndefined();
  });

  it("a stored person wins over the fallback, and the agent slot stays as it was", async () => {
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "alice" });
    h.db.prepare("INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, 'operator', 't')").run(todo.id, `user:${collab.userId}`);
    expect(store.getWorkItem(todo.id)).toMatchObject({ humanAssignee: `user:${collab.userId}`, assignee: "alice" });
  });
});

describe("the operator sets and clears the person through the edit route", () => {
  it("sets a board member, writes person_changed {from, to}, bumps the version and leaves the agent slot alone", async () => {
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "alice" });
    const before = store.getWorkItem(todo.id)!;
    const reply = await operatorSet(todo.id, `user:${collab.userId}`);
    expect(reply.status).toBe(200);
    expect(reply.body.workItem).toMatchObject({ humanAssignee: `user:${collab.userId}`, assignee: "alice" });
    expect(reply.body.workItem.version).toBeGreaterThan(before.version);
    expect(events(todo.id).map((event) => event.detail)).toEqual([{ from: null, to: `user:${collab.userId}` }]);
    expect(events(todo.id)[0].actor).toBe("operator");
    expect(storedRow(todo.id)).toMatchObject({ person: `user:${collab.userId}`, set_by: "operator" });
    expect(store.listWorkItemEvents(todo.id).filter((event) => event.kind === "metadata_edited")).toEqual([]);
  });

  it("can always choose themselves: @operator needs no account and no grant", async () => {
    const todo = opsTodo();
    expect((await operatorSet(todo.id, "@operator")).body.workItem.humanAssignee).toBe("@operator");
  });

  it("clears a stored person, and a repeat changes nothing", async () => {
    const todo = opsTodo();
    await operatorSet(todo.id, `user:${owner.userId}`);
    const cleared = await operatorSet(todo.id, null);
    expect(cleared.body.workItem.humanAssignee).toBeNull();
    expect(storedRow(todo.id)).toBeUndefined();
    const again = await operatorSet(todo.id, null);
    expect(again.status).toBe(200);
    expect(again.body.workItem.version).toBe(cleared.body.workItem.version);
    expect(events(todo.id)).toHaveLength(2);
  });

  it("clearing the person of a Todo assigned to the operator clears that assignee too", async () => {
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "@operator" });
    const reply = await operatorSet(todo.id, null);
    expect(reply.body.workItem).toMatchObject({ humanAssignee: null, assignee: null });
    expect(events(todo.id).at(-1)!.detail).toEqual({ from: "@operator", to: null, assigneeCleared: true });
  });

  it("a patch that also hands the Todo to an agent keeps that agent when it clears the person", async () => {
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "@operator" });
    const reply = await h.operator("PATCH", `/api/work-items/${todo.id}`, { assignee: "alice", humanAssignee: null, expectedVersion: store.getWorkItem(todo.id)!.version });
    expect(reply.body.workItem).toMatchObject({ assignee: "alice", humanAssignee: null });
  });

  it("is refused 422 for someone without access to the Todo's board, a disabled user, an unknown user and a malformed value", async () => {
    const todo = opsTodo();
    for (const person of [`user:${elsewhere.userId}`, "user:usr_doesnotexist", "alice", "operator"]) {
      const reply = await operatorSet(todo.id, person);
      expect([person, reply.status]).toEqual([person, 422]);
      expect(reply.body.code).toBe("todo_invalid_person");
    }
    expect((await operatorSet(todo.id, 5)).status).toBe(400);
    expect(storedRow(todo.id)).toBeUndefined();
    const sleeper = await h.join("sleeper@example.test", "collaborator", "ops", "Sam Sleeper");
    await h.operator("PATCH", `/api/people/${sleeper.userId}`, { status: "disabled" });
    expect((await operatorSet(todo.id, `user:${sleeper.userId}`)).status).toBe(422);
    await h.operator("PATCH", `/api/people/${sleeper.userId}`, { status: "active" });
    expect((await operatorSet(todo.id, `user:${sleeper.userId}`)).status).toBe(200);
  });

  it("an instance owner can be chosen on any board, including the company board", async () => {
    const boss = users.createUser(h.db, { email: "boss@example.test", displayName: "Bo Boss", passwordHash: null, instanceRole: "owner", createdBy: "operator" });
    const company = store.createWorkItem({ title: "Company Todo" });
    expect((await operatorSet(company.id, `user:${boss.id}`)).status).toBe(200);
    expect((await operatorSet(company.id, `user:${collab.userId}`)).status).toBe(422);
  });

  it("is not editable by an agent session: the field is operator-only", async () => {
    const authority = await import("../../gateway/todo-edit-authority.js");
    const employee = authority.resolveTodoEditAuthority({ kind: "session", callerId: "s1", session: { employee: "alice" } } as never);
    expect(employee.fields.has("humanAssignee")).toBe(false);
    expect(authority.resolveTodoEditAuthority({ kind: "operator" } as never).fields.has("humanAssignee")).toBe(true);
  });
});

describe("PUT /api/member/todos/:id/person", () => {
  it("a collaborator names themselves on any Todo on their board, an agent's included, and the operator's card hears it", async () => {
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "alice" });
    const sent = h.broadcasts.length;
    const reply = await putPerson(collab, todo.id, `user:${collab.userId}`);
    expect(reply.status).toBe(200);
    expect(reply.body.workItem).toMatchObject({ humanAssignee: `user:${collab.userId}`, assignee: "alice" });
    expect(events(todo.id)[0]).toMatchObject({ actor: `user:${collab.userId}`, detail: { from: null, to: `user:${collab.userId}` } });
    const frame = h.broadcasts.slice(sent).find((b) => b.event === "company:changed" && b.payload.id === todo.id && b.payload.value);
    expect(frame?.payload.value.humanAssignee).toBe(`user:${collab.userId}`);
  });

  it("a collaborator may name another person on the board, or clear it, but never the operator", async () => {
    const todo = opsTodo();
    expect((await putPerson(collab, todo.id, `user:${owner.userId}`)).body.workItem.humanAssignee).toBe(`user:${owner.userId}`);
    const operator = await putPerson(collab, todo.id, "@operator");
    expect([operator.status, operator.body.code]).toEqual([422, "todo_invalid_person"]);
    expect(store.getWorkItem(todo.id)).toMatchObject({ humanAssignee: `user:${owner.userId}`, assignee: null });
    expect((await putPerson(collab, todo.id, null)).body.workItem.humanAssignee).toBeNull();
  });

  it("an owner can set it", async () => {
    const todo = opsTodo();
    expect((await putPerson(owner, todo.id, `user:${owner.userId}`)).status).toBe(200);
  });

  it("a viewer is refused 403", async () => {
    const todo = opsTodo();
    const reply = await putPerson(viewer, todo.id, `user:${viewer.userId}`);
    expect(reply.status).toBe(403);
    expect(storedRow(todo.id)).toBeUndefined();
  });

  it("a member of another board gets 404, as for any other member route", async () => {
    const todo = opsTodo();
    const reply = await putPerson(elsewhere, todo.id, `user:${elsewhere.userId}`);
    expect(reply.status).toBe(404);
    expect(storedRow(todo.id)).toBeUndefined();
  });

  it("a disabled user's session is refused before the route", async () => {
    const todo = opsTodo();
    const ghost = await h.join("ghost@example.test", "collaborator", "ops", "Gus Ghost");
    await h.operator("PATCH", `/api/people/${ghost.userId}`, { status: "disabled" });
    const reply = await putPerson(ghost, todo.id, `user:${ghost.userId}`);
    expect([401, 403]).toContain(reply.status);
    expect(storedRow(todo.id)).toBeUndefined();
  });

  it("refuses 422 a person without access to this board or who is unknown, and 400 a malformed body", async () => {
    const todo = opsTodo();
    expect((await putPerson(collab, todo.id, `user:${elsewhere.userId}`)).status).toBe(422);
    expect((await putPerson(collab, todo.id, "user:usr_doesnotexist")).status).toBe(422);
    expect((await putPerson(collab, todo.id, "alice")).status).toBe(422);
    expect((await putPerson(collab, todo.id, 7)).status).toBe(400);
    expect((await h.as(collab, "PUT", `/api/member/todos/${todo.id}/person`, { person: null, extra: 1 })).status).toBe(400);
    expect((await h.as(collab, "PUT", `/api/member/todos/${todo.id}/person`, { assignee: "alice" })).status).toBe(403);
    expect(storedRow(todo.id)).toBeUndefined();
  });

  it("answers 403 and changes nothing on a Todo whose person is the operator, whether by the assignee or by a row beside an agent", async () => {
    const needsYou = opsTodo();
    store.updateWorkItem(needsYou.id, { assignee: "@operator" });
    const withAgent = opsTodo();
    store.updateWorkItem(withAgent.id, { assignee: "alice" });
    await operatorSet(withAgent.id, "@operator");
    expect(store.getWorkItem(withAgent.id)).toMatchObject({ assignee: "alice", humanAssignee: "@operator" });
    for (const todo of [needsYou, withAgent]) {
      const before = JSON.stringify([store.getWorkItem(todo.id), storedRow(todo.id), events(todo.id)]);
      for (const person of [null, `user:${collab.userId}`]) {
        const reply = await putPerson(collab, todo.id, person);
        expect([todo.id, person, reply.status, reply.body.code]).toEqual([todo.id, person, 403, "person_operator_only"]);
      }
      expect(JSON.stringify([store.getWorkItem(todo.id), storedRow(todo.id), events(todo.id)])).toBe(before);
    }
  });

  it("a member's set or clear leaves assignee, the dispatch and auto-start rows and the board walk's view byte-identical, and wakes nothing", async () => {
    const walk = await import("../../board-walk/board.js");
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "alice" });
    const snapshot = () => JSON.stringify({
      assignee: (h.db.prepare("SELECT assignee, status FROM work_items WHERE id = ?").get(todo.id)),
      dispatch: h.db.prepare("SELECT * FROM work_item_dispatch WHERE work_item_id = ?").all(todo.id),
      autoStart: h.db.prepare("SELECT * FROM work_item_auto_start WHERE work_item_id = ?").all(todo.id),
      walk: walk.noAutoStartReason(store.getWorkItem(todo.id)!) ?? null,
      sessions: h.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE work_item_id = ?").get(todo.id),
      kinds: store.listWorkItemEvents(todo.id).map((event) => event.kind).filter((kind) => kind !== "person_changed"),
    });
    const before = snapshot();
    expect((await putPerson(collab, todo.id, `user:${collab.userId}`)).status).toBe(200);
    expect(snapshot()).toBe(before);
    expect((await putPerson(collab, todo.id, null)).status).toBe(200);
    expect(snapshot()).toBe(before);
  });

  it("never touches the agent slot, status or dispatch", async () => {
    const todo = opsTodo();
    store.updateWorkItem(todo.id, { assignee: "alice" });
    const before = h.db.prepare("SELECT status, assignee FROM work_items WHERE id = ?").get(todo.id);
    const sessions = (h.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    await putPerson(collab, todo.id, `user:${collab.userId}`);
    expect(h.db.prepare("SELECT status, assignee FROM work_items WHERE id = ?").get(todo.id)).toEqual(before);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(sessions);
  });
});

describe("a member-created Todo starts with its creator as the person", () => {
  it("writes the row with the create, for a root and a sub-task", async () => {
    const root = (await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "Mine" })).body.workItem;
    expect(root.humanAssignee).toBe(`user:${collab.userId}`);
    expect(storedRow(root.id)).toMatchObject({ person: `user:${collab.userId}`, set_by: `user:${collab.userId}` });
    const sub = (await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "Sub", parentId: root.id })).body.workItem;
    expect(sub.humanAssignee).toBe(`user:${collab.userId}`);
  });

  it("a replayed create writes no second row and an operator-made Todo has none", async () => {
    const first = await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "Once", idempotencyKey: "k-1" });
    const again = await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "Once", idempotencyKey: "k-1" });
    expect(again.body.replayed).toBe(true);
    expect(again.body.workItem.id).toBe(first.body.workItem.id);
    expect(opsTodo().humanAssignee).toBeNull();
  });
});
