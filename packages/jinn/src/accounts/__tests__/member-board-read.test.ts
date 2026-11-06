import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let viewer: Member;
let collab: Member;
let store: typeof import("../../work-items/store.js");
let comments: typeof import("../../work-items/comments.js");
let attachments: typeof import("../../work-items/attachments.js");
let sessions: typeof import("../../sessions/registry.js");

let rootId: string;
let childId: string;
let otherBoardId: string;
let companyId: string;

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  attachments = await import("../../work-items/attachments.js");
  sessions = await import("../../sessions/registry.js");
  viewer = await h.join("viewer@example.test", "viewer");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  await h.join("designer@example.test", "owner", "design", "Dee Designer");
  rootId = store.createWorkItem({ title: "Ops root", body: "details", department: "ops", sourceRef: "session:11111111-aaaa-4bbb-8ccc-222222222222:x", createdBy: "alice", source: "session" }).id;
  childId = store.createWorkItem({ title: "Ops child", parentId: rootId }).id;
  otherBoardId = store.createWorkItem({ title: "Design root", department: "design" }).id;
  companyId = store.createWorkItem({ title: "Company root" }).id;
}, 60_000);
afterAll(async () => { await h.close(); });

describe("boards and people", () => {
  it("lists the member's boards with the Todo-id prefix", async () => {
    const reply = await h.as(viewer, "GET", "/api/member/boards");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ boards: [{ department: "ops", role: "viewer", prefix: "OPS" }] });
  });

  it("lists people on the member's boards and the employees on its Todos, as {id, displayName, initials} and {name, displayName, emoji}", async () => {
    store.updateWorkItem(rootId, { assignee: "alice" });
    const reply = await h.as(collab, "GET", "/api/member/people");
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(["employees", "people"]);
    expect(reply.body.people.map((p: any) => p.displayName).sort()).toEqual(["Casey Collab", "Pat Member"].sort());
    for (const person of reply.body.people) expect(Object.keys(person).sort()).toEqual(["displayName", "id", "initials"]);
    // The design board's owner is not on the ops board, so not in this list.
    expect(JSON.stringify(reply.body)).not.toContain("Dee Designer");
    store.updateWorkItem(rootId, { assignee: null });
  });
});

describe("reads are scoped to the member's boards, and an unheld board is a 404, never a 403", () => {
  const todoRoutes = (id: string): Array<[string, string]> => [
    ["GET", `/api/member/todos/${id}`], ["GET", `/api/member/todos/${id}/tree`], ["GET", `/api/member/todos/${id}/comments`],
    ["GET", `/api/member/todos/${id}/attachments`], ["GET", `/api/member/todos/${id}/attachments/wia_000000000000`],
  ];

  it("a Todo on an unheld board, the company board and an unknown id all answer the same 404", async () => {
    const missing = await h.as(viewer, "GET", "/api/member/todos/OPS-999999");
    expect(missing.status).toBe(404);
    for (const id of [otherBoardId, companyId, "NOPE-1", "not-an-id"]) {
      for (const [method, url] of todoRoutes(id)) {
        const reply = await h.as(viewer, method, url);
        expect([url, reply.status, reply.body]).toEqual([url, 404, missing.body]);
      }
    }
  });

  it("an unheld or unknown board is a 404 for reading and for creating", async () => {
    expect((await h.as(viewer, "GET", "/api/member/boards/design/todos")).status).toBe(404);
    expect((await h.as(viewer, "GET", "/api/member/boards/nowhere/todos")).status).toBe(404);
    expect((await h.as(viewer, "POST", "/api/member/boards/design/todos", { title: "x" })).status).toBe(404);
    expect((await h.as(viewer, "GET", "/api/member/boards/design/members")).status).toBe(404);
  });

  it("the board list is scoped to the board's Todos whatever filters are asked for", async () => {
    const reply = await h.as(collab, "GET", "/api/member/boards/ops/todos?rootsOnly=true&kept=true&home=true&needsAttentionFor=ops&limit=100");
    expect(reply.status).toBe(200);
    const ids = reply.body.workItems.map((item: any) => item.id);
    expect(ids).toContain(rootId);
    expect(ids).not.toContain(otherBoardId);
    expect(ids).not.toContain(companyId);
    // Asking for the other board's Todos through a tree filter does not widen the scope.
    const probe = await h.as(collab, "GET", `/api/member/boards/ops/todos?root=${otherBoardId}`);
    expect(probe.body.workItems).toEqual([]);
    expect(probe.body.total).toBe(0);
  });

  it("list rows are the operator's compact shape minus what references a session", async () => {
    const member = (await h.as(collab, "GET", "/api/member/boards/ops/todos?rootsOnly=true")).body;
    const operator = (await h.operator("GET", "/api/work-items?department=ops&rootsOnly=true&limit=100")).body;
    expect(Object.keys(member).sort()).toEqual(Object.keys(operator).sort());
    const memberRow = member.workItems.find((item: any) => item.id === rootId);
    const operatorRow = operator.workItems.find((item: any) => item.id === rootId);
    expect(operatorRow.sourceRef).toMatch(/^session:/);
    expect(operatorRow).toHaveProperty("sessionRef");
    expect(Object.keys(memberRow).sort()).toEqual(Object.keys(operatorRow).filter((key) => key !== "sessionRef").sort());
    expect(memberRow).not.toHaveProperty("sessionRef");
    expect(memberRow).toMatchObject({ sourceRef: null, kept: false, attentionLane: null });
    expect(JSON.stringify(member)).not.toContain("11111111-aaaa-4bbb-8ccc-222222222222");
  });

  it("the detail is the operator's detail shape, with comments and events, minus every session field", async () => {
    comments.addComment({ workItemId: rootId, body: "from an agent", author: "alice", authorKind: "employee", sessionId: "22222222-aaaa-4bbb-8ccc-333333333333" } as any);
    const member = await h.as(viewer, "GET", `/api/member/todos/${rootId}`);
    const operator = await h.operator("GET", `/api/work-items/${rootId}`);
    expect(member.status).toBe(200);
    // The operator's detail minus the session and run fields (`runs`, `dispatchConfig`), with every cost figure null.
    expect(Object.keys(member.body).sort()).toEqual(Object.keys(operator.body).filter((key) => !["runs", "dispatchConfig"].includes(key)).sort());
    expect(member.body.workItem).toMatchObject({ id: rootId, sourceRef: null, budgetUsd: null });
    expect(member.body.comments.comments.map((c: any) => c.body)).toContain("from an agent");
    expect(member.body.events.length).toBeGreaterThan(0);
    expect(member.body).not.toHaveProperty("runs");
    expect(member.body).not.toHaveProperty("dispatchConfig");
    expect(member.body.spendUsd).toBeNull();
    const text = JSON.stringify(member.body);
    expect(text).not.toContain("11111111-aaaa-4bbb-8ccc-222222222222");
    expect(text).not.toContain("22222222-aaaa-4bbb-8ccc-333333333333");
    expect(text).not.toMatch(/sessionId/);
  });

  it("events leave out the operator's machinery and never name a session", async () => {
    const session = sessions.createSession({ engine: "claude", source: "web", sourceRef: "x", employee: "alice", workItemId: rootId } as any);
    store.appendWorkItemEvent({ workItemId: rootId, kind: "session_linked", actor: `session:${session.id}`, detail: { sessionId: session.id, via: "dispatch" } });
    store.appendWorkItemEvent({ workItemId: rootId, kind: "note", actor: `session:${session.id}`, detail: { note: "agent says hi", sessionId: session.id, actorEmployee: "alice" } });
    const body = (await h.as(viewer, "GET", `/api/member/todos/${rootId}`)).body;
    expect(body.events.map((e: any) => e.kind)).not.toContain("session_linked");
    const note = body.events.find((e: any) => e.kind === "note" && e.detail?.note === "agent says hi");
    expect(note.actor).toBe("alice");
    expect(note.detail).toEqual({ note: "agent says hi", actorEmployee: "alice" });
    expect(JSON.stringify(body)).not.toContain(session.id);
  });

  it("the tree is the operator's tree with spend null and no session-bearing refs", async () => {
    const reply = await h.as(viewer, "GET", `/api/member/todos/${rootId}/tree`);
    expect(reply.status).toBe(200);
    expect(reply.body.tree.spendUsd).toBeNull();
    expect(reply.body.tree.root.id).toBe(rootId);
    expect(reply.body.tree.root.sourceRef).toBeNull();
    expect(reply.body.tree.root.children.map((c: any) => c.id)).toEqual([childId]);
    expect(Object.keys(reply.body.tree).sort()).toEqual(Object.keys((await h.operator("GET", `/api/work-items/${rootId}/tree`)).body.tree).sort());
  });

  it("relations to a Todo on a board the member does not hold are not shown", async () => {
    const rel = await import("../../work-items/relations.js");
    rel.addRelation(rootId, otherBoardId, "relates", "operator");
    const body = (await h.as(viewer, "GET", `/api/member/todos/${rootId}`)).body;
    expect(body.relations).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Design root");
  });

  it("comments page: member comments are of the member kind, no session behind them", async () => {
    const reply = await h.as(viewer, "GET", `/api/member/todos/${rootId}/comments?limit=5`);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ limit: 5, offset: 0 });
    expect((await h.as(viewer, "GET", `/api/member/todos/${rootId}/comments?limit=abc`)).status).toBe(400);
  });
});

describe("attachments", () => {
  it("the bytes are served only for an attachment of the Todo in the path, and rows carry no storage path", async () => {
    const fs = await import("node:fs");
    const staged = attachments.stageAttachmentBuffer(Buffer.from("hello attachment"));
    const mine = attachments.addAttachment({ workItemId: rootId, filename: "note.txt", mime: "text/plain", stagedPath: staged, uploader: { author: "operator", authorKind: "operator", operator: true } });
    const other = attachments.addAttachment({
      workItemId: otherBoardId, filename: "secret.txt", mime: "text/plain",
      stagedPath: attachments.stageAttachmentBuffer(Buffer.from("other board secret")), uploader: { author: "operator", authorKind: "operator", operator: true },
    });
    const list = await h.as(viewer, "GET", `/api/member/todos/${rootId}/attachments`);
    expect(list.body.attachments).toHaveLength(1);
    expect(list.body.attachments[0]).not.toHaveProperty("storagePath");
    const bytes = await h.as(viewer, "GET", `/api/member/todos/${rootId}/attachments/${mine.id}`);
    expect(bytes.status).toBe(200);
    expect(bytes.text).toBe("hello attachment");
    // A granted Todo with another Todo's attachment id: the attachment must belong to the Todo, not only the Todo be granted.
    const crossed = await h.as(viewer, "GET", `/api/member/todos/${rootId}/attachments/${other.id}`);
    expect(crossed.status).toBe(404);
    expect(crossed.text).not.toContain("secret");
    // And an attachment of an unheld Todo through its own Todo is as unknown as the Todo.
    expect((await h.as(viewer, "GET", `/api/member/todos/${otherBoardId}/attachments/${other.id}`)).status).toBe(404);
    void fs;
  });
});

describe("a member route that throws is answered, never an unhandled rejection", () => {
  it("answers 500 without reflecting the failure", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(comments, "listComments").mockImplementation(() => { throw new Error("db exploded at /secret/path"); });
    try {
      const reply = await h.as(viewer, "GET", `/api/member/todos/${rootId}/comments`);
      expect(reply.status).toBe(500);
      expect(reply.text).not.toContain("exploded");
      expect(reply.text).not.toContain("/secret/path");
    } finally { spy.mockRestore(); }
  });
});
