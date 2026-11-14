import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-comment-idempotency-"));
process.env.HUNDREDFOLD_HOME = home;

let store: typeof import("../store.js");
let comments: typeof import("../comments.js");

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  (await import("../../shared/db.js")).initDb();
});

describe("comment operation identity", () => {
  it("replays one durable operation without a second comment or version bump", () => {
    const item = store.createWorkItem({ title: "retry-safe comment" });
    const input = {
      workItemId: item.id,
      body: "committed once",
      author: "operator",
      authorKind: "operator" as const,
      origin: "talk" as const,
      idempotencyKey: "talk:session-1:provider-call-1",
    };

    const first = comments.addComment(input);
    const replay = comments.addComment(input);

    expect(replay).toEqual(first);
    expect(comments.listComments(item.id).comments).toHaveLength(1);
    expect(store.getWorkItem(item.id)!.version).toBe(item.version + 1);
    expect(store.listWorkItemEvents(item.id).filter((event) => event.kind === "comment_added")).toHaveLength(1);
    expect(() => comments.addComment({ ...input, body: "changed retry" })).toThrow(/idempotency|different input/i);
  });
});
