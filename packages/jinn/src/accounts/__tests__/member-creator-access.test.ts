import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/**
 * A member keeps read access, and comment access if their role allowed comments, to an open tree whose root they created
 * after it leaves their boards (another department, or the company board). No edits, no status changes, nothing else in
 * the destination, and the access ends when the root closes, the member is disabled or they lose their last grant.
 */
let h: BoardHarness;
let store: typeof import("../../work-items/store.js");
let transition: typeof import("../../work-items/transitions.js").transition;
let pat: Member; // collaborator on design: creates the Todos
let dee: Member; // viewer on design: another person on the same board
let ola: Member; // collaborator on ops

class FakeSocket {
  readyState = 1;
  frames: any[] = [];
  closedWith: number | undefined;
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
}
const connect = (member: Member) => {
  const socket = new FakeSocket();
  h.rt.memberSockets.add(socket, member.sessionId);
  return socket;
};

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  ({ transition } = await import("../../work-items/transitions.js"));
  pat = await h.join("pat@example.test", "collaborator", "design", "Pat Creator");
  dee = await h.join("dee@example.test", "viewer", "design", "Dee Viewer");
  ola = await h.join("ola@example.test", "collaborator", "ops", "Ola Ops");
}, 60_000);
afterAll(async () => { await h.close(); });

beforeEach(() => {
  h.db.prepare("UPDATE board_members SET role = 'collaborator' WHERE user_id = ? AND department = 'design'").run(pat.userId);
  h.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(pat.userId);
  h.db.prepare("INSERT OR IGNORE INTO board_members (user_id, department, role, granted_by, granted_at) VALUES (?, 'design', 'collaborator', 'operator', ?)")
    .run(pat.userId, new Date().toISOString());
});

/** A root Todo pat creates on the design board through the member API, with a sub-task of their own and one the operator adds. */
async function patRoot(): Promise<{ root: string; mine: string; theirs: string }> {
  const root = (await h.as(pat, "POST", "/api/member/boards/design/todos", { title: "Pat's request" })).body.workItem.id as string;
  const mine = (await h.as(pat, "POST", "/api/member/boards/design/todos", { title: "Pat's sub-task", parentId: root })).body.workItem.id as string;
  const theirs = store.createWorkItem({ title: "Operator's sub-task", parentId: root }).id;
  return { root, mine, theirs };
}

const assign = (id: string, assignee: string) => h.operator("POST", `/api/work-items/${id}/assign`, { assignee });
const detail = (member: Member, id: string) => h.as(member, "GET", `/api/member/todos/${id}`);

describe("an assignment that moves the root to another department", () => {
  it("still reads (detail, tree, comments, attachments), marked moved, with no destination named", async () => {
    const t = await patRoot();
    expect((await assign(t.root, "alice")).status).toBe(200);
    expect(store.getWorkItem(t.root)!.department).toBe("ops");
    for (const id of [t.root, t.mine, t.theirs]) {
      const read = await detail(pat, id);
      expect(read.status).toBe(200);
      expect(read.body.workItem.movedToAnotherBoard).toBe(true);
      // The root's own department is the destination, never named; a sub-task keeps the board it was made on.
      if (id === t.root) expect(read.body.workItem.department).toBeNull();
    }
    const tree = await h.as(pat, "GET", `/api/member/todos/${t.root}/tree`);
    expect(tree.status).toBe(200);
    expect(tree.body.tree.root.children.map((c: any) => c.id).sort()).toEqual([t.mine, t.theirs].sort());
    expect(tree.body.tree.root.movedToAnotherBoard).toBe(true);
    expect((await h.as(pat, "GET", `/api/member/todos/${t.theirs}/comments`)).status).toBe(200);
    expect((await h.as(pat, "GET", `/api/member/todos/${t.root}/attachments`)).status).toBe(200);
    // Nothing the member reads names the board it went to.
    const everything = JSON.stringify([(await detail(pat, t.root)).body, tree.body]);
    expect(everything).not.toMatch(/"department":"ops"/);
    expect(everything).not.toMatch(/"movedTo"/);
  });

  it("lists it under the moved group and on no board", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    const moved = await h.as(pat, "GET", "/api/member/moved");
    expect(moved.status).toBe(200);
    expect(moved.body.workItems.map((w: any) => w.id)).toContain(t.root);
    expect(moved.body.workItems.find((w: any) => w.id === t.root)).toMatchObject({ movedToAnotherBoard: true, department: null });
    expect(moved.body.workItems.find((w: any) => w.id === t.root).sessionRef).toBeUndefined();
    const board = await h.as(pat, "GET", "/api/member/boards/design/todos?rootsOnly=true&limit=100");
    expect(board.body.workItems.map((w: any) => w.id)).not.toContain(t.root);
    expect((await h.as(dee, "GET", "/api/member/moved")).body.workItems).toEqual([]);
  });

  it("answers 404 for every other Todo in the destination, and for another member", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    const other = store.createWorkItem({ title: "Ops only", department: "ops" });
    const otherSub = store.createWorkItem({ title: "Ops sub", parentId: other.id });
    for (const id of [other.id, otherSub.id]) {
      expect((await detail(pat, id)).status).toBe(404);
      expect((await h.as(pat, "GET", `/api/member/todos/${id}/tree`)).status).toBe(404);
      expect((await h.as(pat, "POST", `/api/member/todos/${id}/comments`, { body: "hi" })).status).toBe(404);
    }
    expect((await detail(dee, t.root)).status).toBe(404); // someone else on the board they left
    expect((await detail(ola, t.root)).status).toBe(200); // a member of the board it went to reads it there, as on any board
    // The destination board is still not theirs.
    expect((await h.as(pat, "GET", "/api/member/boards/ops/todos")).status).toBe(404);
  });

  it("allows comments when their role allowed them, but no edit, status change or sub-task", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    const comment = await h.as(pat, "POST", `/api/member/todos/${t.theirs}/comments`, { body: "Any news?" });
    expect(comment.status).toBe(201);
    expect(comment.body.comment.author).toBe(`user:${pat.userId}`);
    const mine = comment.body.comment.id as string;
    expect((await h.as(pat, "PATCH", `/api/member/todos/${t.theirs}/comments/${mine}`, { body: "Any news, please?" })).status).toBe(200);
    const version = store.getWorkItem(t.root)!.version;
    const edit = await h.as(pat, "PATCH", `/api/member/todos/${t.root}`, { title: "Renamed", expectedVersion: version });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("todo_not_member_editable");
    expect((await h.as(pat, "PATCH", `/api/member/todos/${t.mine}`, { labels: [] })).status).toBe(403);
    expect((await h.as(pat, "POST", `/api/member/todos/${t.mine}/status`, { status: "done" })).status).toBe(403);
    expect((await h.as(pat, "POST", `/api/member/boards/design/todos`, { title: "more", parentId: t.root })).status).toBe(404);
    expect(store.getWorkItem(t.root)).toMatchObject({ title: "Pat's request", department: "ops" });
    expect(store.getWorkItem(t.mine)!.status).toBe("backlog");
  });

  it("refuses comments, but keeps reads, once their role is read-only", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    h.db.prepare("UPDATE board_members SET role = 'viewer' WHERE user_id = ? AND department = 'design'").run(pat.userId);
    expect((await detail(pat, t.root)).status).toBe(200);
    const refused = await h.as(pat, "POST", `/api/member/todos/${t.root}/comments`, { body: "hello" });
    expect(refused.status).toBe(403);
  });
});

describe("an assignment to @operator, which leaves the company board", () => {
  it("keeps the same reads and comment access, and the same refusals", async () => {
    const t = await patRoot();
    expect((await assign(t.root, "@operator")).status).toBe(200);
    expect(store.getWorkItem(t.root)!.department).toBeNull();
    const read = await detail(pat, t.root);
    expect(read.status).toBe(200);
    expect(read.body.workItem).toMatchObject({ movedToAnotherBoard: true, department: null });
    expect((await detail(pat, t.theirs)).status).toBe(200);
    expect((await h.as(pat, "POST", `/api/member/todos/${t.root}/comments`, { body: "ok" })).status).toBe(201);
    expect((await h.as(pat, "POST", `/api/member/todos/${t.mine}/status`, { status: "done" })).status).toBe(403);
    expect((await h.as(pat, "GET", "/api/member/moved")).body.workItems.map((w: any) => w.id)).toContain(t.root);
    // Other company-board Todos are not theirs.
    const company = store.createWorkItem({ title: "company" });
    expect((await detail(pat, company.id)).status).toBe(404);
  });
});

describe("an assignment within the board's department", () => {
  it("stays readable and commentable, is not member-editable, and is not 'moved'", async () => {
    const root = (await h.as(ola, "POST", "/api/member/boards/ops/todos", { title: "Ola's request" })).body.workItem.id as string;
    expect((await assign(root, "alice")).status).toBe(200);
    expect(store.getWorkItem(root)!.department).toBe("ops");
    const read = await detail(ola, root);
    expect(read.status).toBe(200);
    expect(read.body.workItem.movedToAnotherBoard).toBeUndefined();
    expect(read.body.workItem.department).toBe("ops");
    expect((await h.as(ola, "POST", `/api/member/todos/${root}/comments`, { body: "ok" })).status).toBe(201);
    const edit = await h.as(ola, "PATCH", `/api/member/todos/${root}`, { title: "x", expectedVersion: store.getWorkItem(root)!.version });
    expect(edit.status).toBe(403);
    expect((await h.as(ola, "GET", "/api/member/moved")).body.workItems.map((w: any) => w.id)).not.toContain(root);
  });
});

describe("a member who also holds the destination board reads it there, as on any board", () => {
  it("is not marked moved and the board is named", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    h.db.prepare("INSERT INTO board_members (user_id, department, role, granted_by, granted_at) VALUES (?, 'ops', 'viewer', 'operator', ?)")
      .run(pat.userId, new Date().toISOString());
    try {
      const read = await detail(pat, t.root);
      expect(read.body.workItem.movedToAnotherBoard).toBeUndefined();
      expect(read.body.workItem.department).toBe("ops");
      expect((await h.as(pat, "GET", "/api/member/moved")).body.workItems.map((w: any) => w.id)).not.toContain(t.root);
    } finally {
      h.db.prepare("DELETE FROM board_members WHERE user_id = ? AND department = 'ops'").run(pat.userId);
    }
  });
});

describe("access ends", () => {
  it("when the root is done or cancelled", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const t = await patRoot();
      await assign(t.root, "@operator");
      expect((await detail(pat, t.root)).status).toBe(200);
      transition(t.theirs, status === "done" ? "done" : "cancelled", "operator", { cascade: true, manual: true } as never);
      transition(t.mine, status === "done" ? "done" : "cancelled", "operator", { cascade: true, manual: true } as never);
      transition(t.root, status, "operator", { cascade: true, manual: true } as never);
      expect(store.getWorkItem(t.root)!.status).toBe(status);
      for (const id of [t.root, t.mine, t.theirs]) expect((await detail(pat, id)).status).toBe(404);
      expect((await h.as(pat, "GET", `/api/member/todos/${t.root}/tree`)).status).toBe(404);
      expect((await h.as(pat, "POST", `/api/member/todos/${t.root}/comments`, { body: "late" })).status).toBe(404);
      expect((await h.as(pat, "GET", "/api/member/moved")).body.workItems.map((w: any) => w.id)).not.toContain(t.root);
    }
  });

  it("when the member is disabled", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(pat.userId);
    expect((await detail(pat, t.root)).status).toBe(401);
  });

  it("when the member loses their last grant", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    h.db.prepare("DELETE FROM board_members WHERE user_id = ?").run(pat.userId);
    expect((await detail(pat, t.root)).status).toBe(404);
    expect((await h.as(pat, "GET", "/api/member/moved")).body.workItems).toEqual([]);
  });

  it("not while they hold another board, even if the one it left was removed", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    h.db.prepare("INSERT INTO board_members (user_id, department, role, granted_by, granted_at) VALUES (?, 'ops', 'viewer', 'operator', ?)")
      .run(pat.userId, new Date().toISOString());
    h.db.prepare("DELETE FROM board_members WHERE user_id = ? AND department = 'design'").run(pat.userId);
    try {
      expect((await detail(pat, t.root)).status).toBe(200); // read through the board it went to
      store.updateWorkItem(t.root, { department: "design" });
      const read = await detail(pat, t.root);
      expect(read.status).toBe(200); // not on a board they hold, still theirs and open
      expect(read.body.workItem.movedToAnotherBoard).toBe(true);
      expect((await h.as(pat, "POST", `/api/member/todos/${t.root}/comments`, { body: "x" })).status).toBe(403); // viewer now
    } finally {
      h.db.prepare("DELETE FROM board_members WHERE user_id = ?").run(pat.userId);
    }
  });
});

describe("a root the member did not create is lost on a move", () => {
  it("the operator's root on the board, assigned away, is a 404 for everyone on the board", async () => {
    const root = store.createWorkItem({ title: "Operator's", department: "design" }).id;
    expect((await detail(pat, root)).status).toBe(200);
    await assign(root, "alice");
    expect((await detail(pat, root)).status).toBe(404);
  });

  it("a sub-task a member made under the operator's root gives them no access once it is moved", async () => {
    const root = store.createWorkItem({ title: "Operator's", department: "design" }).id;
    const sub = store.createWorkItem({ title: "mine?", parentId: root, createdBy: `user:${pat.userId}` }).id;
    await assign(root, "alice");
    expect((await detail(pat, sub)).status).toBe(404);
  });
});

describe("live frames", () => {
  it("a moved tree's changes reach its creator, sub-tasks included, and nobody else but the destination's members", async () => {
    const t = await patRoot();
    const patSocket = connect(pat);
    const deeSocket = connect(dee);
    const olaSocket = connect(ola);
    try {
      await assign(t.root, "alice");
      // The root's own move: the creator hears the root as a change (a card marked moved), not as removed; the rest of the board loses it.
      const rootFrames = patSocket.frames.filter((f) => f.payload.id === t.root);
      expect(rootFrames.length).toBeGreaterThan(0);
      expect(rootFrames.every((f) => f.payload.action !== "removed")).toBe(true);
      expect(deeSocket.frames.filter((f) => f.payload.id === t.root).map((f) => f.payload.action)).toEqual(["removed"]);
      for (const socket of [patSocket, deeSocket]) {
        expect(JSON.stringify(socket.frames)).not.toContain('"department":"ops"');
      }
      patSocket.frames.length = 0; deeSocket.frames.length = 0; olaSocket.frames.length = 0;

      // A change to a sub-task of the moved root.
      await h.operator("POST", `/api/work-items/${t.theirs}/comments`, { body: "working on it" });
      expect(patSocket.frames.map((f) => f.payload.id)).toContain(t.theirs);
      expect(deeSocket.frames).toEqual([]);
      expect(olaSocket.frames.map((f) => f.payload.id)).toContain(t.theirs); // the destination's own members hear it as any Todo on their board
      const valueFrame = patSocket.frames.find((f) => f.payload.value);
      if (valueFrame) expect(valueFrame.payload.value).toMatchObject({ sourceRef: null, budgetUsd: null });

      // Another tree in the destination is not theirs.
      const other = store.createWorkItem({ title: "Ops only", department: "ops" });
      patSocket.frames.length = 0;
      h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "updated", id: other.id, version: 1 });
      expect(patSocket.frames).toEqual([]);
    } finally {
      for (const socket of [patSocket, deeSocket, olaSocket]) h.rt.memberSockets.remove(socket);
    }
  });

  it("closing the root sends its creator `removed` for the root only, then nothing", async () => {
    const t = await patRoot();
    await assign(t.root, "@operator");
    const patSocket = connect(pat);
    try {
      transition(t.theirs, "done", "operator", { cascade: true, manual: true } as never);
      transition(t.mine, "done", "operator", { cascade: true, manual: true } as never);
      patSocket.frames.length = 0;
      transition(t.root, "done", "operator", { cascade: true, manual: true } as never);
      expect(patSocket.frames.map((f) => f.payload)).toEqual([{ entity: "todo", action: "removed", id: t.root }]);
      patSocket.frames.length = 0;
      await h.operator("POST", `/api/work-items/${t.theirs}/comments`, { body: "after the close" });
      expect(patSocket.frames).toEqual([]); // a sub-task of a closed tree is no longer theirs
    } finally {
      h.rt.memberSockets.remove(patSocket);
    }
  });

  it("a disabled member's socket is closed and hears nothing", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    const patSocket = connect(pat);
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(pat.userId);
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "commented", id: t.theirs, version: 1 });
    expect(patSocket.closedWith).toBe(4401);
    expect(patSocket.frames).toEqual([]);
  });

  it("a member's own comment on a moved Todo reaches their other socket", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    const patSocket = connect(pat);
    try {
      await h.as(pat, "POST", `/api/member/todos/${t.theirs}/comments`, { body: "hello" });
      expect(patSocket.frames.map((f) => f.payload.action)).toContain("commented");
    } finally {
      h.rt.memberSockets.remove(patSocket);
    }
  });
});

describe("the member people list", () => {
  it("names the employee a moved tree is assigned to, so the card renders them as an agent", async () => {
    const t = await patRoot();
    await assign(t.root, "alice");
    const people = await h.as(pat, "GET", "/api/member/people");
    expect(people.body.employees.map((e: any) => e.name)).toContain("alice");
  });
});
