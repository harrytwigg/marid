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
