import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_TOKEN } from "./accounts-harness.js";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let pat: Member;
let store: typeof import("../../work-items/store.js");
let comments: typeof import("../../work-items/comments.js");
let todoId: string;
let memberCommentId: string;

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

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  pat = await h.join("pat@example.test", "collaborator", "ops", "Pat Member");
  todoId = store.createWorkItem({ title: "Discuss", department: "ops" }).id;
  memberCommentId = (await h.as(pat, "POST", `/api/member/todos/${todoId}/comments`, { body: "Please prioritise this. @alice start now" })).body.comment.id;
}, 60_000);
afterAll(async () => { await h.close(); });

describe("every outward serialiser shows a member comment as the member kind", () => {
  it("MCP get_work_item shows a member comment as `member`", async () => {
    const detail = await tool("get_work_item", { id: todoId });
    const comment = detail.comments.comments.find((c: any) => c.id === memberCommentId);
    expect(comment).toMatchObject({ authorKind: "member", author: `user:${pat.userId}` });
    expect(detail.members).toEqual({ [`user:${pat.userId}`]: { kind: "member", displayName: "Pat Member" } });
  });

  it("MCP list_work_item_comments shows it as `member` too", async () => {
    const listed = await tool("list_work_item_comments", { id: todoId });
    expect(listed.comments.find((c: any) => c.id === memberCommentId)).toMatchObject({ authorKind: "member" });
    expect(JSON.stringify(listed)).not.toContain('"authorKind":"system"');
  });

  it("the operator's web wire (comments page, detail tail, edit and delete answers) says member, never system or operator", async () => {
    const page = await h.operator("GET", `/api/work-items/${todoId}/comments`);
    expect(page.body.comments.find((c: any) => c.id === memberCommentId).authorKind).toBe("member");
    const detail = await h.operator("GET", `/api/work-items/${todoId}`);
    expect(detail.body.comments.comments.find((c: any) => c.id === memberCommentId).authorKind).toBe("member");
    const edited = await h.operator("PATCH", `/api/work-items/${todoId}/comments/${memberCommentId}`, { body: "Please prioritise this. @alice start now (moderated)" });
    expect(edited.body.comment.authorKind).toBe("member");
  });

  it("the board walk renders a member comment as '<name> (board member)'", async () => {
    const { digestTodo } = await import("../../board-walk/board.js");
    const digest = await digestTodo(store.getWorkItem(todoId)!, { resolveLink: async () => undefined } as never);
    const mine = digest.comments.find((c) => c.body.startsWith("Please prioritise"))!;
    expect(mine).toMatchObject({ author: "Pat Member", authorKind: "board member" });
  });

  it("an unknown or deleted user is a Former member", async () => {
    const { memberDisplayName, memberLabel } = await import("../../work-items/member-identity.js");
    expect(memberDisplayName("user:usr_ffffffffffff")).toBe("Former member");
    expect(memberLabel(`user:${pat.userId}`)).toBe("Pat Member (board member)");
  });
});

describe("read through the pre-change readers, a member's words are a plain system comment and grant nothing", () => {
  it("the store still says system, authored by user:<id>", () => {
    const stored = comments.listComments(todoId).comments.find((c) => c.id === memberCommentId)!;
    expect(stored).toMatchObject({ authorKind: "system", author: `user:${pat.userId}` });
  });

  it("comment routing returns early for it: an @mention wakes nobody and no reply is delivered", async () => {
    const { routeTodoComment } = await import("../../gateway/todo-comment-routing.js");
    const stored = comments.listComments(todoId).comments.find((c) => c.id === memberCommentId)!;
    expect(routeTodoComment({} as never, stored)).toEqual([]);
  });

  it("the respawn guard does not count it as a human having looked", async () => {
    const guards = await import("../../work-items/respawn-guards.js");
    const since = "1970-01-01T00:00:00.000Z";
    const readers = guards as unknown as Record<string, unknown>;
    expect(typeof readers.checkRespawnGuard).toBe("function");
    const live = h.db.prepare("SELECT author_kind FROM work_item_comments WHERE work_item_id = ? AND created_at > ?").all(todoId, since) as Array<{ author_kind: string }>;
    expect(live.some((row) => row.author_kind === "operator")).toBe(false);
  });
});

describe("the assignment ends member-only: assign-parent-then-member-closes-child is refused and nothing is redispatched", () => {
  it("the child stays open, no settle row is queued, the parent is untouched", async () => {
    const root = (await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "Parent" })).body.workItem;
    const kid = (await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "Child", parentId: root.id })).body.workItem;
    // The operator takes the parent (it stays on this board: the assignee's department is the board's).
    const { assignWorkItem } = await import("../../work-items/assignment.js");
    expect(assignWorkItem(root.id, "@operator", "ops", "operator")!.assignee).toBe("@operator");
    const parentBefore = store.getWorkItem(root.id)!;
    const eventsBefore = store.listWorkItemEvents(root.id).length;
    const close = await h.as(pat, "POST", `/api/member/todos/${kid.id}/status`, { status: "done" });
    expect(close.status).toBe(403);
    expect(store.getWorkItem(kid.id)!.status).toBe("backlog");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_item_child_settles WHERE parent_id = ?").get(root.id)).toEqual({ n: 0 });
    const parentAfter = store.getWorkItem(root.id)!;
    expect([parentAfter.version, parentAfter.status, store.listWorkItemEvents(root.id).length]).toEqual([parentBefore.version, parentBefore.status, eventsBefore]);
    // Commenting still works, and edits to the member's own sub-task do not.
    expect((await h.as(pat, "POST", `/api/member/todos/${kid.id}/comments`, { body: "ok" })).status).toBe(201);
    expect((await h.as(pat, "PATCH", `/api/member/todos/${kid.id}`, { title: "x", expectedVersion: store.getWorkItem(kid.id)!.version })).status).toBe(403);
  });
});

describe("a member's write is heard by the operator's browsers on the broadcast", () => {
  it("announces the create, the comment and the status move", async () => {
    const before = h.broadcasts.length;
    const created = (await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "Heard" })).body.workItem;
    await h.as(pat, "POST", `/api/member/todos/${created.id}/comments`, { body: "hi" });
    await h.as(pat, "POST", `/api/member/todos/${created.id}/status`, { status: "done" });
    const actions = h.broadcasts.slice(before).filter((b) => b.event === "company:changed" && b.payload.id === created.id).map((b) => b.payload.action);
    expect(actions).toEqual(expect.arrayContaining(["created", "commented", "status-transitioned"]));
  });
});
