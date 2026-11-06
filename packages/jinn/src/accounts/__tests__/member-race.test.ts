import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/**
 * The invariants a member write rests on are checked inside the write's own transaction, not when the request is routed:
 * the operator can move, assign or dispatch a Todo, or remove a grant, while the member's body is still arriving.
 */
let h: BoardHarness;
let pat: Member;
let store: typeof import("../../work-items/store.js");
let labels: typeof import("../../work-items/labels.js");
let operatorRoot: string;

/**
 * A request whose body arrives in two parts, with `between` run once the gateway has routed it, made every check it makes
 * before reading the body, and started reading it: `between` lands after those checks and before the write.
 */
async function slowRequest(member: Member, method: string, path: string, body: { first: string; second: string; contentType?: string }, between: () => Promise<void>): Promise<{ status: number; body: any }> {
  const url = new URL(h.baseUrl);
  const reading = h.bodyReadStarted(path);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path, method,
      headers: { cookie: member.cookie, "content-type": body.contentType ?? "application/json", "transfer-encoding": "chunked" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        // An answer given before the body was read never reached the in-transaction check: the test fails, naming it.
        reading.then(() => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }), reject);
      });
    });
    req.on("error", reject);
    req.write(body.first);
    void reading.then(between).then(() => req.end(body.second), reject);
  });
}

const own = async (title: string, parentId?: string) =>
  (await h.as(pat, "POST", "/api/member/boards/ops/todos", { title, ...(parentId ? { parentId } : {}) })).body.workItem;

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  pat = await h.join("pat@example.test", "collaborator");
  operatorRoot = store.createWorkItem({ title: "Operator's", department: "ops" }).id;
  labels.createLabel({ name: "urgent" });
}, 60_000);
afterAll(async () => { await h.close(); });

const moveUnderOperatorTree = async (id: string) => {
  const moved = await h.operator("PUT", `/api/work-items/${id}/parent`, { parentId: operatorRoot });
  expect(moved.status).toBe(200);
};

describe("a Todo that stops being member-only while the body arrives", () => {
  it("a status move is refused and writes nothing", async () => {
    const todo = await own("to close");
    const reply = await slowRequest(pat, "POST", `/api/member/todos/${todo.id}/status`, { first: '{"status":', second: '"done"}' }, () => moveUnderOperatorTree(todo.id));
    expect([reply.status, reply.body.code]).toEqual([403, "todo_not_member_editable"]);
    expect(store.getWorkItem(todo.id)!.status).toBe("backlog");
  });

  it("a labels-only edit is refused and writes nothing", async () => {
    const todo = await own("to label");
    const reply = await slowRequest(pat, "PATCH", `/api/member/todos/${todo.id}`, { first: '{"labels":', second: '["urgent"]}' }, () => moveUnderOperatorTree(todo.id));
    expect(reply.status).toBe(403);
    expect(labels.getWorkItemLabels(todo.id)).toEqual([]);
  });

  it("a sub-task is refused under a parent that is no longer in a member-only tree", async () => {
    const parent = await own("parent");
    const reply = await slowRequest(pat, "POST", "/api/member/boards/ops/todos", { first: '{"title":"kid",', second: `"parentId":"${parent.id}"}` }, () => moveUnderOperatorTree(parent.id));
    expect(reply.status).toBe(403);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE title = 'kid'").get()).toEqual({ n: 0 });
  });
});

describe("a grant that goes while the body arrives", () => {
  it("a comment is refused with the 404 an unheld Todo answers", async () => {
    const lee = await h.join("lee@example.test", "collaborator", "ops", "Lee Member");
    const todo = await own("discussed");
    const reply = await slowRequest(lee, "POST", `/api/member/todos/${todo.id}/comments`, { first: '{"body":', second: '"too late"}' }, async () => {
      expect((await h.operator("DELETE", `/api/boards/ops/members/${lee.userId}`)).status).toBe(200);
    });
    expect(reply.status).toBe(404);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_item_comments WHERE body = 'too late'").get()).toEqual({ n: 0 });
  });

  it("a file upload is refused and stores nothing", async () => {
    const sam = await h.join("sam@example.test", "collaborator", "ops", "Sam Member");
    const todo = (await h.as(sam, "POST", "/api/member/boards/ops/todos", { title: "sam's" })).body.workItem;
    const boundary = "----race";
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.txt"\r\nContent-Type: text/plain\r\n\r\nlate`;
    const reply = await slowRequest(sam, "POST", `/api/member/todos/${todo.id}/attachments`,
      { first: head, second: `\r\n--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` },
      async () => { expect((await h.operator("DELETE", `/api/boards/ops/members/${sam.userId}`)).status).toBe(200); });
    expect(reply.status).toBe(404);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_item_attachments WHERE work_item_id = ?").get(todo.id)).toEqual({ n: 0 });
  });

  it("a role lowered to viewer turns a write into a 403", async () => {
    const kim = await h.join("kim@example.test", "collaborator", "ops", "Kim Member");
    const todo = (await h.as(kim, "POST", "/api/member/boards/ops/todos", { title: "kim's" })).body.workItem;
    const reply = await slowRequest(kim, "POST", `/api/member/todos/${todo.id}/status`, { first: '{"status":', second: '"done"}' }, async () => {
      expect((await h.operator("PATCH", `/api/boards/ops/members/${kim.userId}`, { role: "viewer" })).status).toBe(200);
    });
    expect(reply.status).toBe(403);
    expect(store.getWorkItem(todo.id)!.status).toBe("backlog");
  });
});

describe("other write answers", () => {
  it("an unknown label answers a generic 400 that does not list the company's labels", async () => {
    labels.createLabel({ name: "secret-design-only" });
    const reply = await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "labelled", labels: ["nope"] });
    expect(reply.status).toBe(400);
    expect(reply.text).not.toContain("secret-design-only");
    expect(reply.text).not.toContain("urgent");
  });

  it("a failure that is not the caller's to fix is a plain 500, never the raw message", async () => {
    const spy = (await import("vitest")).vi.spyOn(store, "createWorkItem").mockImplementation(() => { throw new Error("SQLITE_ERROR: no such table secret_table"); });
    try {
      const reply = await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "boom" });
      expect(reply.status).toBe(500);
      expect(reply.text).not.toContain("secret_table");
    } finally { spy.mockRestore(); }
  });

  it("an idempotent create replay does not hand back a Todo that has left the member's boards", async () => {
    const first = await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "once", idempotencyKey: "replay-1" });
    expect(first.status).toBe(201);
    h.db.prepare("UPDATE work_items SET department = 'design' WHERE id = ?").run(first.body.workItem.id);
    const again = await h.as(pat, "POST", "/api/member/boards/ops/todos", { title: "once", idempotencyKey: "replay-1" });
    expect(again.status).toBe(404);
  });
});
