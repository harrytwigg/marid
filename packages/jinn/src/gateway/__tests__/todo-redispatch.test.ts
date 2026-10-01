import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiContext } from "../api.js";

/**
 * `redispatchTodo` is how availability resume and Todo recovery restart stalled
 * work. It restarts only mid-flight Todos, through the Todo Dispatcher, and
 * folds every way the Dispatcher can decline into an `unavailable` answer so a
 * sweep never throws.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-redispatch-"));
process.env.JINN_HOME = tmp;

const startTodoDispatcher = vi.hoisted(() => vi.fn());
vi.mock("../todo-dispatch.js", () => ({ startTodoDispatcher }));

type Store = typeof import("../../work-items/store.js");
type Redispatch = typeof import("../todo-redispatch.js");

let store: Store;
let redispatchTodo: Redispatch["redispatchTodo"];

const context = {} as unknown as ApiContext;
const REASON = "This is a restart: the previous attempt stalled.";

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  ({ redispatchTodo } = await import("../todo-redispatch.js"));
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  startTodoDispatcher.mockReset();
});

describe("redispatchTodo", () => {
  it.each(["in_review", "blocked", "done"] as const)("refuses a %s Todo without calling the Dispatcher", (status) => {
    const item = store.createWorkItem({ title: `${status} work`, status });

    const result = redispatchTodo(item.id, context, REASON);

    expect(result).toEqual({ unavailable: expect.stringContaining(status) });
    expect(startTodoDispatcher).not.toHaveBeenCalled();
  });

  it("reports a Todo that no longer exists as unavailable", () => {
    expect(redispatchTodo("TST-9999", context, REASON)).toEqual({ unavailable: expect.any(String) });
    expect(startTodoDispatcher).not.toHaveBeenCalled();
  });

  it("starts the Dispatcher for an executing Todo, with the reason as its prompt suffix", () => {
    const item = store.createWorkItem({ title: "stalled work", status: "executing", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({
      ok: true, status: 201, body: { workItemId: item.id, sessionId: "sess-1", status: "running", reused: false },
    });

    const result = redispatchTodo(item.id, context, REASON);

    expect(result).toEqual({ status: "executing" });
    expect(startTodoDispatcher).toHaveBeenCalledTimes(1);
    const [passedItem, passedContext, opts] = startTodoDispatcher.mock.calls[0]!;
    expect(passedItem).toMatchObject({ id: item.id, status: "executing" });
    expect(passedContext).toBe(context);
    expect(opts.promptSuffix).toBe(REASON);
    expect(typeof opts.emitProjectionEvent).toBe("function");
  });

  it("starts the Dispatcher for an assigned Todo too", () => {
    const item = store.createWorkItem({ title: "queued work", status: "assigned", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({
      ok: true, status: 201, body: { workItemId: item.id, sessionId: "sess-2", status: "running", reused: false },
    });

    expect(redispatchTodo(item.id, context, REASON)).toEqual({ status: "assigned" });
    expect(startTodoDispatcher).toHaveBeenCalledTimes(1);
  });

  it("maps a reused Dispatcher to unavailable, since the work is already moving", () => {
    const item = store.createWorkItem({ title: "already moving", status: "executing", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({
      ok: true, status: 200, body: { workItemId: item.id, sessionId: "sess-3", status: "running", reused: true },
    });

    expect(redispatchTodo(item.id, context, REASON)).toEqual({ unavailable: expect.stringMatching(/already running/) });
  });

  it("maps a refused start to unavailable, carrying the Dispatcher's error text", () => {
    const item = store.createWorkItem({ title: "refused start", status: "executing", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({ ok: false, status: 409, body: { error: "no engine is available" } });

    expect(redispatchTodo(item.id, context, REASON)).toEqual({ unavailable: "no engine is available" });
  });
});
