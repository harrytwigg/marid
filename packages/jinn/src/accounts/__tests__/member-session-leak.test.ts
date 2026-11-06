import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/** A session id is not a member's to hold, wherever an agent's work shows up: creators, comment authors, uploaders, relations, frames. */
let h: BoardHarness;
let viewer: Member;
let store: typeof import("../../work-items/store.js");
let todoId: string;
let childId: string;
const BARE = "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d"; // a session with no employee
let employeeSession: string; // a session whose employee is known

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  const comments = await import("../../work-items/comments.js");
  const attachments = await import("../../work-items/attachments.js");
  const relations = await import("../../work-items/relations.js");
  const { createSession } = await import("../../sessions/registry.js");
  viewer = await h.join("viewer@example.test", "viewer");
  employeeSession = createSession({ engine: "claude", source: "web", sourceRef: "t", employee: "alice" } as never).id;
  todoId = store.createWorkItem({
    title: "Made by an employee-less session", department: "ops", source: "session", sourceRef: `session:${BARE}:x`, createdBy: `session:${BARE}`,
  }).id;
  childId = store.createWorkItem({ title: "Made by alice's session", parentId: todoId, source: "session", sourceRef: `session:${employeeSession}:y`, createdBy: `session:${employeeSession}` }).id;
  comments.addComment({ workItemId: todoId, body: "from the bare session", author: `session:${BARE}`, authorKind: "employee", sessionId: BARE } as never);
  attachments.addAttachment({
    workItemId: todoId, filename: "log.txt", mime: "text/plain", stagedPath: attachments.stageAttachmentBuffer(Buffer.from("x")),
    uploader: { author: `session:${BARE}`, authorKind: "employee", operator: false },
  });
  const other = store.createWorkItem({ title: "Related", department: "ops" }).id;
  relations.addRelation(todoId, other, "relates", `session:${BARE}`);
}, 60_000);
afterAll(async () => { await h.close(); });

const noSessionIds = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(BARE);
  expect(text).not.toContain(employeeSession);
  expect(text).not.toMatch(/session:/);
};

describe("members read only an employee, operator, a user or a generic agent/system: never a plugin, cron or machinery id", () => {
  it("a plugin's and a cron job's Todo and comments, and the gateway's own events", async () => {
    const comments = await import("../../work-items/comments.js");
    const plugin = store.createWorkItem({ title: "From a plugin", department: "ops", source: "connector", sourceRef: "plugin:calendar:1", createdBy: "plugin:calendar" });
    const cron = store.createWorkItem({ title: "From cron", department: "ops", source: "cron", sourceRef: "cron:nightly-sweep:2026-11-06", createdBy: "cron:nightly-sweep" });
    comments.addComment({ workItemId: plugin.id, body: "plugin says hi", author: "plugin:calendar", authorKind: "system" });
    comments.addComment({ workItemId: plugin.id, body: "walk says hi", author: "board-walk", authorKind: "system" });
    store.appendWorkItemEvent({ workItemId: cron.id, kind: "note", actor: "reconciler", detail: { note: "derived" } });
    store.appendWorkItemEvent({ workItemId: plugin.id, kind: "note", actor: "plugin:calendar", detail: { note: "plugin note" } });
    for (const id of [plugin.id, cron.id]) {
      const detail = (await h.as(viewer, "GET", `/api/member/todos/${id}`)).body;
      expect(JSON.stringify(detail)).not.toMatch(/plugin:|cron:|calendar|nightly-sweep|reconciler|board-walk/);
      expect(detail.workItem.createdBy).toBe("system");
    }
    const page = (await h.as(viewer, "GET", `/api/member/todos/${plugin.id}/comments`)).body;
    expect(page.comments.map((c: any) => c.author)).toEqual(["system", "system"]);
    const list = (await h.as(viewer, "GET", "/api/member/boards/ops/todos?limit=100")).body;
    expect(JSON.stringify(list)).not.toMatch(/plugin:|cron:|nightly-sweep/);
  });
});

describe("members read an agent's work without its session id", () => {
  it("the board list, detail and tree name the creator as the session's employee, or 'agent'", async () => {
    const list = (await h.as(viewer, "GET", "/api/member/boards/ops/todos?limit=100")).body;
    noSessionIds(list);
    expect(list.workItems.find((i: any) => i.id === todoId).createdBy).toBe("agent");
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todoId}`)).body;
    noSessionIds(detail);
    expect(detail.workItem.createdBy).toBe("agent");
    const tree = (await h.as(viewer, "GET", `/api/member/todos/${todoId}/tree`)).body;
    noSessionIds(tree);
    expect(tree.tree.root.children.find((c: any) => c.id === childId).createdBy).toBe("alice");
  });

  it("comments, attachments and relations too", async () => {
    const comments = (await h.as(viewer, "GET", `/api/member/todos/${todoId}/comments`)).body;
    noSessionIds(comments);
    expect(comments.comments.find((c: any) => c.body === "from the bare session").author).toBe("agent");
    const attachments = (await h.as(viewer, "GET", `/api/member/todos/${todoId}/attachments`)).body;
    noSessionIds(attachments);
    expect(attachments.attachments[0].uploadedBy).toBe("agent");
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todoId}`)).body;
    expect(detail.relations[0].createdBy).toBe("agent");
  });

  it("a socket frame's value does not carry it either", async () => {
    const frames: any[] = [];
    h.rt.memberSockets.add({ readyState: 1, close() {}, send: (data: string) => frames.push(JSON.parse(data)) }, viewer.sessionId);
    const item = store.getWorkItem(todoId)!;
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "created", id: todoId, version: item.version, value: item, sessionId: BARE });
    expect(frames).toHaveLength(1);
    noSessionIds(frames);
    expect(frames[0].payload.value.createdBy).toBe("agent");
  });
});
