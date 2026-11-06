import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let ops: Member;
let design: Member;
let store: typeof import("../../work-items/store.js");

class FakeSocket {
  readyState = 1;
  frames: any[] = [];
  closedWith: number | undefined;
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
}
let opsSocket: FakeSocket;
let designSocket: FakeSocket;

const connect = (member: Member) => {
  const socket = new FakeSocket();
  h.rt.memberSockets.add(socket, member.sessionId);
  return socket;
};

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  ops = await h.join("ops@example.test", "viewer", "ops", "Ola Ops");
  design = await h.join("design@example.test", "viewer", "design", "Dee Design");
}, 60_000);
afterAll(async () => { await h.close(); });

beforeEach(() => {
  for (const socket of [opsSocket, designSocket]) if (socket) h.rt.memberSockets.remove(socket);
  opsSocket = connect(ops);
  designSocket = connect(design);
});

describe("a member's socket hears only re-serialised Todo changes on its own boards", () => {
  it("never receives a non-Todo event", () => {
    for (const [event, payload] of [
      ["session:delta", { sessionId: "s1", type: "text", content: "secret transcript" }],
      ["session:updated", { sessionId: "s1" }], ["org:changed", {}], ["config:reloaded", {}], ["hooks:run", { id: "x" }],
      ["notes:changed", { path: "a.md", action: "updated", revision: "1" }],
      ["company:changed", { entity: "sprint", action: "moved", id: "OPS-1" }],
      ["company:changed", { entity: "department", action: "changed", id: "ops" }],
      ["company:changed", { entity: "todo" }], ["company:changed", null], ["company:changed", "OPS-1"],
    ] as const) h.rt.memberSockets.publish(event, payload);
    expect(opsSocket.frames).toEqual([]);
    expect(designSocket.frames).toEqual([]);
  });

  it("sends { entity, action, id } and the version for a Todo on a granted board, and nothing for another board", () => {
    const todo = store.createWorkItem({ title: "Ops work", department: "ops" });
    h.broadcasts.length = 0;
    opsSocket.frames.length = 0; designSocket.frames.length = 0;
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "commented", id: todo.id, version: 7, sessionId: "aaaaaaaa-0000-4000-8000-000000000000" });
    expect(opsSocket.frames).toEqual([{ event: "company:changed", payload: { entity: "todo", action: "commented", id: todo.id, version: todo.version }, ts: expect.any(Number) }]);
    expect(designSocket.frames).toEqual([]);
    expect(JSON.stringify(opsSocket.frames)).not.toContain("aaaaaaaa");
  });

  it("re-serialises a carried value as the member-safe Todo: no session-bearing sourceRef, no budget", () => {
    const todo = store.createWorkItem({ title: "From a session", department: "ops", source: "session", sourceRef: "session:aaaaaaaa-1111-4000-8000-000000000000:abc", createdBy: "alice", budgetUsd: 12 });
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "created", id: todo.id, version: todo.version, value: todo, sessionId: "aaaaaaaa-1111-4000-8000-000000000000" });
    const frame = opsSocket.frames.at(-1);
    expect(frame.payload.value).toMatchObject({ id: todo.id, title: "From a session", sourceRef: null, budgetUsd: null });
    expect(JSON.stringify(frame)).not.toContain("aaaaaaaa");
    expect(Object.keys(frame.payload).sort()).toEqual(["action", "entity", "id", "value", "version"]);
  });

  it("a Todo on the company board, or one that is gone, reaches no member", () => {
    const company = store.createWorkItem({ title: "company" });
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "updated", id: company.id, version: 1 });
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "updated", id: "OPS-424242", version: 1 });
    expect(opsSocket.frames).toEqual([]);
    expect(designSocket.frames).toEqual([]);
  });

  it("a Todo moved off a granted board sends { entity: 'todo', action: 'removed', id }, and the new board hears it as a change", async () => {
    const todo = store.createWorkItem({ title: "Moves", department: "ops" });
    opsSocket.frames.length = 0; designSocket.frames.length = 0;
    const moved = await h.operator("PATCH", `/api/work-items/${todo.id}`, { department: "design", expectedVersion: todo.version });
    expect(moved.status).toBe(200);
    expect(opsSocket.frames.map((f) => f.payload)).toEqual([{ entity: "todo", action: "removed", id: todo.id }]);
    expect(designSocket.frames.map((f) => [f.payload.action, f.payload.id])).toEqual([["metadata-updated", todo.id]]);
  });

  it("an assignment that derives another department (the assignee's) removes the card too", async () => {
    const todo = store.createWorkItem({ title: "Assigned away", department: "ops" });
    opsSocket.frames.length = 0;
    const assigned = await h.operator("POST", `/api/work-items/${todo.id}/assign`, { assignee: "@operator" });
    expect(assigned.status).toBe(200);
    expect(store.getWorkItem(todo.id)!.department).toBeNull();
    expect(opsSocket.frames.map((f) => f.payload)).toEqual([{ entity: "todo", action: "removed", id: todo.id }]);
  });

  it("a reparent across boards removes the moved Todo from the board it left", async () => {
    const a = store.createWorkItem({ title: "A", department: "ops" });
    const b = store.createWorkItem({ title: "B", department: "design" });
    opsSocket.frames.length = 0; designSocket.frames.length = 0;
    const reparented = await h.operator("PUT", `/api/work-items/${a.id}/parent`, { parentId: b.id });
    expect(reparented.status).toBe(200);
    expect(opsSocket.frames.map((f) => f.payload)).toEqual([{ entity: "todo", action: "removed", id: a.id }]);
    expect(designSocket.frames.map((f) => f.payload.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("comment, attachment and status changes announced by the real write paths arrive", async () => {
    const todo = store.createWorkItem({ title: "Live", department: "ops" });
    opsSocket.frames.length = 0;
    await h.operator("POST", `/api/work-items/${todo.id}/comments`, { body: "hello" });
    const { transition } = await import("../../work-items/transitions.js");
    store.updateWorkItem(todo.id, { title: "Live!" });
    transition(todo.id, "done", "operator", {});
    const actions = opsSocket.frames.filter((f) => f.payload.id === todo.id).map((f) => f.payload.action);
    expect(actions).toEqual(expect.arrayContaining(["commented", "status-transitioned"]));
    expect(designSocket.frames.filter((f) => f.payload.id === todo.id)).toEqual([]);
  });
});

describe("a member socket dies with its session", () => {
  it("revoke closes the socket (4401) at once, and a session revoked behind the API's back is closed on the next broadcast, sent nothing", () => {
    const todo = store.createWorkItem({ title: "Late", department: "ops" });
    expect(h.rt.memberSockets.size()).toBeGreaterThan(0);
    h.db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), ops.sessionId);
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "updated", id: todo.id, version: 1 });
    expect(opsSocket.closedWith).toBe(4401);
    expect(opsSocket.frames).toEqual([]);
    expect(designSocket.frames).toHaveLength(0); // not on their board
    expect(designSocket.closedWith).toBeUndefined();
  });

  it("revoking through the API (operator or the member's own) closes the socket", async () => {
    const pat = await h.join("pat@example.test", "viewer", "ops", "Pat Two");
    const socket = connect(pat);
    expect((await h.as(pat, "DELETE", `/api/member/sessions/${pat.sessionId}`)).status).toBe(200);
    expect(socket.closedWith).toBe(4401);
    const lee = await h.join("lee@example.test", "viewer", "ops", "Lee Three");
    const leeSocket = connect(lee);
    await h.operator("PATCH", `/api/people/${lee.userId}`, { status: "disabled" });
    expect(leeSocket.closedWith).toBe(4401);
  });

  it("an expired session is closed by the sweep", () => {
    const gone = connect(design);
    h.db.prepare("UPDATE user_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), design.sessionId);
    h.rt.memberSockets.sweep();
    expect(gone.closedWith).toBe(4401);
  });
});
