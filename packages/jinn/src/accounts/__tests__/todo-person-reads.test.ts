import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_TOKEN } from "./accounts-harness.js";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let collab: Member;
let owner: Member;
let store: typeof import("../../work-items/store.js");
let users: typeof import("../users.js");

const storedRow = (id: string) => h.db.prepare("SELECT * FROM todo_people WHERE todo_id = ?").get(id) as { person: string; set_by: string } | undefined;
const opsTodo = (extra: Record<string, unknown> = {}) => store.createWorkItem({ title: "A Todo", department: "ops", ...extra });
const operatorSet = (id: string, humanAssignee: unknown) =>
  h.operator("PATCH", `/api/work-items/${id}`, { humanAssignee, expectedVersion: store.getWorkItem(id)!.version });

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  users = await import("../users.js");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  owner = await h.join("owner@example.test", "owner", "ops", "Olive Owner");
}, 60_000);
afterAll(async () => { await h.close(); });

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
