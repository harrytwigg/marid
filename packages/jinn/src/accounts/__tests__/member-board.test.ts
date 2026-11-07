import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let pat: Member;
beforeAll(async () => {
  h = await startBoardHarness();
  pat = await h.join("pat@example.test", "collaborator");
}, 60_000);
afterAll(async () => { await h.close(); });

describe("smoke", () => {
  it("a collaborator creates a root Todo and reads it back", async () => {
    const created = await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "First" });
    expect(created.status).toBe(201);
    expect(created.body.workItem.createdBy).toBe(`user:${pat.userId}`);
    const read = await h.as(pat, "GET", `/api/member/todos/${created.body.workItem.id}`);
    expect(read.status).toBe(200);
    expect(Object.keys(read.body)).toContain("comments");
  });
});
