import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_TOKEN } from "./accounts-harness.js";
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

describe("what each reader is shown", () => {
  it("the operator's list, detail and tree carry the field; a member sees the generic member for someone off their boards", async () => {
    const todo = opsTodo();
    await operatorSet(todo.id, `user:${collab.userId}`);
    const list = await h.operator("GET", "/api/work-items?department=ops&limit=200");
    expect(list.body.workItems.find((row: any) => row.id === todo.id).humanAssignee).toBe(`user:${collab.userId}`);
    expect(list.body.members[`user:${collab.userId}`]).toEqual({ kind: "member", displayName: "Casey Collab" });
    const detail = await h.operator("GET", `/api/work-items/${todo.id}`);
    expect(detail.body.workItem.humanAssignee).toBe(`user:${collab.userId}`);
    expect(detail.body.members[`user:${collab.userId}`].displayName).toBe("Casey Collab");
    const tree = await h.operator("GET", `/api/work-items/${todo.id}/tree`);
    expect(tree.body.tree.root.humanAssignee).toBe(`user:${collab.userId}`);

    const member = await h.as(owner, "GET", `/api/member/todos/${todo.id}`);
    expect(member.body.workItem.humanAssignee).toBe(`user:${collab.userId}`);
    // A user who shares none of the reader's boards is only ever "member".
    const peer = await h.join("peer@example.test", "collaborator", "ops", "Pia Peer");
    const stranger = opsTodo();
    await operatorSet(stranger.id, `user:${peer.userId}`);
    expect((await h.as(collab, "GET", `/api/member/todos/${stranger.id}`)).body.workItem.humanAssignee).toBe(`user:${peer.userId}`);
    await h.operator("DELETE", `/api/boards/ops/members/${peer.userId}`);
    const hidden = await h.as(collab, "GET", `/api/member/todos/${stranger.id}`);
    expect(hidden.body.workItem.humanAssignee).toBe("member");
    expect(JSON.stringify(hidden.body)).not.toContain(peer.userId);
  });

  it("the operator shows as @operator to a member, never as a user, and a legacy Todo shows the operator", async () => {
    const legacy = opsTodo();
    store.updateWorkItem(legacy.id, { assignee: "@operator" });
    const read = await h.as(collab, "GET", `/api/member/todos/${legacy.id}`);
    expect(read.body.workItem).toMatchObject({ humanAssignee: "@operator", assignee: "@operator" });
    const board = await h.as(collab, "GET", "/api/member/boards/ops/todos?limit=200");
    expect(board.body.workItems.find((row: any) => row.id === legacy.id).humanAssignee).toBe("@operator");
  });

  it("a member's timeline shows person_changed with its ids mapped like any actor", async () => {
    const todo = opsTodo();
    await operatorSet(todo.id, `user:${collab.userId}`);
    await operatorSet(todo.id, "@operator");
    const read = await h.as(collab, "GET", `/api/member/todos/${todo.id}`);
    const changed = read.body.events.filter((event: any) => event.kind === "person_changed");
    expect(changed.map((event: any) => event.detail)).toEqual([
      { from: null, to: `user:${collab.userId}` },
      { from: `user:${collab.userId}`, to: "@operator" },
    ]);
    expect(changed[0].actor).toBe("operator");
  });
});

describe("deleting a user", () => {
  it("deletes their person rows in the same transaction and leaves everyone else's", async () => {
    const doomed = users.createUser(h.db, { email: "doomed@example.test", displayName: "Dom Doomed", passwordHash: null, createdBy: "operator" });
    const mine = opsTodo();
    const theirs = opsTodo();
    h.db.prepare("INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, 'operator', 't')").run(mine.id, `user:${doomed.id}`);
    h.db.prepare("INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, 'operator', 't')").run(theirs.id, `user:${collab.userId}`);
    expect(users.deleteUser(h.db, doomed.id)).toBe(true);
    expect(storedRow(mine.id)).toBeUndefined();
    expect(storedRow(theirs.id)).toMatchObject({ person: `user:${collab.userId}` });
  });

  it("rolls the rows back with the user when the delete fails", () => {
    const doomed = users.createUser(h.db, { email: "rollback@example.test", displayName: "Rob Rollback", passwordHash: null, createdBy: "operator" });
    const todo = opsTodo();
    h.db.prepare("INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, 'operator', 't')").run(todo.id, `user:${doomed.id}`);
    h.db.exec("CREATE TEMP TRIGGER refuse_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'refused'); END");
    try {
      expect(() => users.deleteUser(h.db, doomed.id)).toThrow(/refused/);
    } finally {
      h.db.exec("DROP TRIGGER refuse_user_delete");
    }
    expect(storedRow(todo.id)).toMatchObject({ person: `user:${doomed.id}` });
  });

  it("removing a grant keeps the row: the person still renders by name", async () => {
    const guest = await h.join("guest@example.test", "collaborator", "ops", "Gwen Guest");
    const todo = opsTodo();
    await operatorSet(todo.id, `user:${guest.userId}`);
    await h.operator("DELETE", `/api/boards/ops/members/${guest.userId}`);
    expect(storedRow(todo.id)).toMatchObject({ person: `user:${guest.userId}` });
    const detail = await h.operator("GET", `/api/work-items/${todo.id}`);
    expect(detail.body.members[`user:${guest.userId}`].displayName).toBe("Gwen Guest");
  });
});

/** An agent's tool call: a real session and the capability the gateway minted for it, as an engine passes them. */
const tool = async (name: string, args: Record<string, unknown>) => {
  const { buildWorkItemTools } = await import("../../mcp/work-item-tools.js");
  const { createSession } = await import("../../sessions/registry.js");
  const { ensureSessionCapability } = await import("../../mcp/identity.js");
  const session = createSession({ engine: "claude", source: "web", sourceRef: "agent", employee: "alice" } as never);
  const found = buildWorkItemTools().find((candidate) => candidate.name === name)!;
  return found.handler(args, {
    gatewayUrl: h.baseUrl, token: GATEWAY_TOKEN, callerSessionId: session.id, sessionCapability: ensureSessionCapability(session.id),
  } as never) as Promise<any>;
};

describe("an agent reads the person as a name, never a user as the operator", () => {
  it("get_work_item and list_work_items say '<name> (board member)' for a user and 'operator' for the operator", async () => {
    const mine = opsTodo({ title: "Agent reads the person" });
    await operatorSet(mine.id, `user:${collab.userId}`);
    const ops = opsTodo({ title: "Operator is the person" });
    await operatorSet(ops.id, "@operator");
    const legacy = opsTodo({ title: "Legacy operator Todo" });
    store.updateWorkItem(legacy.id, { assignee: "@operator" });

    expect((await tool("get_work_item", { id: mine.id })).workItem.humanAssignee).toBe("Casey Collab (board member)");
    expect((await tool("get_work_item", { id: ops.id })).workItem.humanAssignee).toBe("operator");
    expect((await tool("get_work_item", { id: legacy.id })).workItem.humanAssignee).toBe("operator");
    expect((await tool("get_work_item", { id: opsTodo().id })).workItem.humanAssignee).toBeNull();

    const listed = await tool("list_work_items", { department: "ops", limit: 200 });
    const byId = new Map<string, any>(listed.workItems.map((row: any) => [row.id, row]));
    expect(byId.get(mine.id).humanAssignee).toBe("Casey Collab (board member)");
    expect(byId.get(ops.id).humanAssignee).toBe("operator");
    expect(JSON.stringify(listed)).not.toContain(`user:${collab.userId}`);
  });

  it("a deleted user reads Former member, and is never shown as the operator", async () => {
    const gone = users.createUser(h.db, { email: "gone@example.test", displayName: "Gil Gone", passwordHash: null, createdBy: "operator" });
    const todo = opsTodo();
    h.db.prepare("INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, 'operator', 't')").run(todo.id, `user:${gone.id}`);
    h.db.prepare("DELETE FROM users WHERE id = ?").run(gone.id);
    expect((await tool("get_work_item", { id: todo.id })).workItem.humanAssignee).toBe("Former member");
  });
});
