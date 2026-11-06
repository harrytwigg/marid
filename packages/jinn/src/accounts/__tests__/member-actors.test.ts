import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/**
 * Who a member is told did something: a Todo's `created` event names its creator, and a person is named by id only
 * while they are on one of the reader's boards; anyone else is the generic `member`.
 */
let h: BoardHarness;
let pat: Member;
let store: typeof import("../../work-items/store.js");
let comments: typeof import("../../work-items/comments.js");

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  pat = await h.join("pat@example.test", "collaborator");
}, 60_000);
afterAll(async () => { await h.close(); });

const createdActor = async (reader: Member, id: string) =>
  (await h.as(reader, "GET", `/api/member/todos/${id}`)).body.events.find((event: any) => event.kind === "created").actor;

describe("a Todo's created event names its creator, not the write's source", () => {
  it("a member's own Todo reads as theirs", async () => {
    const todo = (await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "Mine" })).body.workItem;
    expect(store.listWorkItemEvents(todo.id).find((event) => event.kind === "created")!.actor).toBe("connector");
    expect(await createdActor(pat, todo.id)).toBe(`user:${pat.userId}`);
  });

  it("an operator's Todo reads as the operator", async () => {
    const created = await h.operator("POST", "/api/work-items", { title: "The operator's", department: "ops" });
    expect(created.status).toBe(201);
    expect(await createdActor(pat, created.body.workItem.id)).toBe("operator");
  });

  it("a cron job's Todo reads as a generic system actor, never the job or the source", async () => {
    const todo = store.createWorkItem({ title: "Nightly", department: "ops", source: "cron", sourceRef: "cron:nightly:2026-11-06", createdBy: "cron:nightly" });
    expect(await createdActor(pat, todo.id)).toBe("system");
    expect(JSON.stringify((await h.as(pat, "GET", `/api/member/todos/${todo.id}`)).body)).not.toMatch(/cron:|nightly/);
  });
});

describe("a user id is named only while that person is on one of the reader's boards", () => {
  it("someone on a shared board passes as user:<id>; someone only on another board, or removed, reads as member", async () => {
    const lee = await h.join("lee@example.test", "collaborator", "ops", "Lee Member");
    const dana = await h.join("dana@example.test", "collaborator", "design", "Dana Design");
    const byLee = (await h.as(lee, "POST", "/api/member/boards/ops/todos", { title: "Lee's" })).body.workItem;
    expect((await h.as(lee, "POST", `/api/member/todos/${byLee.id}/comments`, { body: "from lee" })).status).toBe(201);
    // Dana holds only the design board: a Todo and comment of theirs that ends up on ops must not name them to Pat.
    const byDana = store.createWorkItem({ title: "Dana's", department: "ops", source: "connector", sourceRef: `user:${dana.userId}:n1`, createdBy: `user:${dana.userId}` });
    comments.addComment({ workItemId: byDana.id, body: "from dana", author: `user:${dana.userId}`, authorKind: "system" });

    const leeDetail = (await h.as(pat, "GET", `/api/member/todos/${byLee.id}`)).body;
    expect(leeDetail.workItem.createdBy).toBe(`user:${lee.userId}`);
    expect(leeDetail.comments.comments[0]).toMatchObject({ author: `user:${lee.userId}`, authorKind: "member" });

    const danaDetail = (await h.as(pat, "GET", `/api/member/todos/${byDana.id}`)).body;
    expect(danaDetail.workItem.createdBy).toBe("member");
    expect(danaDetail.events.find((event: any) => event.kind === "created").actor).toBe("member");
    expect(danaDetail.comments.comments[0]).toMatchObject({ author: "member", authorKind: "member" });
    const row = (await h.as(pat, "GET", "/api/member/boards/ops/todos?limit=100")).body.workItems.find((item: any) => item.id === byDana.id);
    expect(row.createdBy).toBe("member");
    expect(JSON.stringify([danaDetail, row])).not.toContain(dana.userId);
    expect(JSON.stringify(danaDetail)).not.toContain("Dana Design");

    // Lee leaves the board: what Lee did now reads as member too, on every path, frames included.
    expect((await h.operator("DELETE", `/api/boards/ops/members/${lee.userId}`)).status).toBe(200);
    const after = (await h.as(pat, "GET", `/api/member/todos/${byLee.id}`)).body;
    expect(after.workItem.createdBy).toBe("member");
    expect(after.comments.comments[0]).toMatchObject({ author: "member", authorKind: "member" });
    const frames: any[] = [];
    const socket = { readyState: 1, close() {}, send: (data: string) => frames.push(JSON.parse(data)) };
    h.rt.memberSockets.add(socket, pat.sessionId);
    const live = store.getWorkItem(byLee.id)!;
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "updated", id: live.id, version: live.version, value: live });
    h.rt.memberSockets.remove(socket);
    expect(frames[0].payload.value.createdBy).toBe("member");
    expect(JSON.stringify([after, frames])).not.toContain(lee.userId);
  });
});

describe("GET /api/member/boards", () => {
  it("names the prefix of a board that has no Todos yet, the one its first Todo then carries", async () => {
    fs.mkdirSync(path.join(h.home, "org", "fresh"), { recursive: true });
    expect(h.db.prepare("SELECT 1 FROM departments WHERE slug = 'fresh'").get()).toBeUndefined();
    const kai = await h.join("kai@example.test", "collaborator", "fresh", "Kai Fresh");
    const board = (await h.as(kai, "GET", "/api/member/boards")).body.boards.find((row: any) => row.department === "fresh");
    expect(board.prefix).toMatch(/^[A-Z]+$/);
    const first = (await h.as(kai, "POST", "/api/member/boards/fresh/todos", { title: "First" })).body.workItem;
    expect(first.id.startsWith(`${board.prefix}-`)).toBe(true);
  });
});

describe("event details name only Todos on the reader's boards", () => {
  it("a relation to a Todo on an unheld board leaves no trace of its id; one on a held board keeps it", async () => {
    const onOps = store.createWorkItem({ title: "On ops", department: "ops" }).id;
    const alsoOps = store.createWorkItem({ title: "Also ops", department: "ops" }).id;
    const onDesign = store.createWorkItem({ title: "On design", department: "design" }).id;
    expect((await h.operator("POST", `/api/work-items/${onDesign}/relations`, { kind: "relates", dstId: onOps })).status).toBe(201);
    expect((await h.operator("POST", `/api/work-items/${alsoOps}/relations`, { kind: "blocks", dstId: onOps })).status).toBe(201);
    const detail = (await h.as(pat, "GET", `/api/member/todos/${onOps}`)).body;
    const added = detail.events.filter((event: any) => event.kind === "relation_added");
    expect(added).toHaveLength(2);
    expect(detail.relations.map((relation: any) => relation.other.id)).toEqual([alsoOps]);
    expect(JSON.stringify(detail)).not.toContain(onDesign);
    expect(JSON.stringify(added)).toContain(alsoOps);
  });

  it("a Todo moved in from an unheld board's tree names neither its old parent nor its old root", async () => {
    const designRoot = store.createWorkItem({ title: "Design root", department: "design" }).id;
    const moving = store.createWorkItem({ title: "Moving", parentId: designRoot }).id;
    const grandchild = store.createWorkItem({ title: "Grandchild", parentId: moving }).id;
    const opsRoot = store.createWorkItem({ title: "Ops root", department: "ops" }).id;
    expect((await h.operator("PUT", `/api/work-items/${moving}/parent`, { parentId: opsRoot })).status).toBe(200);
    const detail = (await h.as(pat, "GET", `/api/member/todos/${moving}`)).body;
    expect(store.listWorkItemEvents(moving).some((event) => JSON.stringify(event.detail).includes(designRoot))).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(designRoot);
    for (const id of [opsRoot, grandchild]) {
      const read = (await h.as(pat, "GET", `/api/member/todos/${id}`)).body;
      expect(JSON.stringify(read.events)).not.toContain(designRoot);
    }
    // The ids that are on the reader's boards stay: the new parent is named on the moved Todo, the child on its new parent.
    expect(JSON.stringify(detail.events)).toContain(opsRoot);
    expect(JSON.stringify((await h.as(pat, "GET", `/api/member/todos/${opsRoot}`)).body.events)).toContain(moving);
  });
});

describe("a disabled account is no longer named", () => {
  it("their Todo, comment and list row read as member while their grant row remains", async () => {
    const ray = await h.join("ray@example.test", "collaborator", "ops", "Ray Member");
    const todo = (await h.as(ray, "POST", "/api/member/boards/ops/todos", { title: "Ray's" })).body.workItem;
    expect((await h.as(ray, "POST", `/api/member/todos/${todo.id}/comments`, { body: "from ray" })).status).toBe(201);
    expect((await h.as(pat, "GET", `/api/member/todos/${todo.id}`)).body.workItem.createdBy).toBe(`user:${ray.userId}`);
    expect((await h.operator("PATCH", `/api/people/${ray.userId}`, { status: "disabled" })).status).toBe(200);
    expect(h.db.prepare("SELECT 1 FROM board_members WHERE user_id = ?").get(ray.userId)).toBeDefined();
    const detail = (await h.as(pat, "GET", `/api/member/todos/${todo.id}`)).body;
    expect(detail.workItem.createdBy).toBe("member");
    expect(detail.comments.comments[0]).toMatchObject({ author: "member", authorKind: "member" });
    const row = (await h.as(pat, "GET", "/api/member/boards/ops/todos?limit=200")).body.workItems.find((item: any) => item.id === todo.id);
    expect(row.createdBy).toBe("member");
    expect(JSON.stringify([detail, row])).not.toContain(ray.userId);
  });
});
