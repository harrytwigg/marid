import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempHome } from "./db-fixtures.js";

useTempHome("jinn-board-hooks-dispatch-");

const spawnMock = vi.fn();
vi.mock("../../gateway/spawn-session.js", () => ({ spawnSession: (...args: unknown[]) => spawnMock(...args) }));

type Store = typeof import("../../work-items/store.js");
type Runs = typeof import("../run-store.js");
type Db = ReturnType<typeof import("../../shared/db.js").initDb>;
let store: Store;
let runs: Runs;
let db: Db;
let transitions: typeof import("../../work-items/transitions.js");
let labels: typeof import("../../work-items/labels.js");
let hooks: typeof import("../index.js");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-hooks-cwd-"));
const sent: Array<{ target: unknown; text: string }> = [];
const emitted: Array<{ id: string; hook: string; status: string }> = [];
const connectors = new Map<string, unknown>();
let config: { hooks?: unknown[] } = {};

const context = {
  getConfig: () => config,
  emit: (event: string, payload: { id: string; hook: string; status: string }) => { if (event === "hooks:run") emitted.push(payload); },
  connectors,
} as never;

const reviewHook = (extra: Record<string, unknown> = {}) => ({
  name: "review-merge",
  event: "todo.status_changed",
  match: { from: "executing", to: "in_review", label: "auto-merge" },
  action: { spawn: { employee: "merger", prompt: "{{todo.id}} moved {{from}} -> {{to}}" } },
  ...extra,
});

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  runs = await import("../run-store.js");
  transitions = await import("../../work-items/transitions.js");
  labels = await import("../../work-items/labels.js");
  hooks = await import("../index.js");
  db = (await import("../../shared/db.js")).initDb();
  labels.createLabel({ name: "auto-merge" });
});

beforeEach(() => {
  config = {};
  sent.length = 0;
  emitted.length = 0;
  connectors.clear();
  spawnMock.mockReset();
  spawnMock.mockResolvedValue({ ok: true, dispatched: true, session: { id: "spawned-1" } });
  db.prepare("DELETE FROM board_hook_runs").run();
  hooks.installBoardHooks(context);
});

afterEach(() => hooks.stopBoardHooks());
afterAll(() => hooks.stopBoardHooks());

/** A labelled Todo that is executing and ready to be moved to review. */
function labelled(title = "T"): string {
  const item = store.createWorkItem({ title, assignee: "senior-developer" });
  labels.addWorkItemLabels(item.id, ["auto-merge"], "operator");
  transitions.transition(item.id, "executing", "operator", { human: true, manual: true });
  return item.id;
}

const toReview = (id: string, actor = "operator") => transitions.transition(id, "in_review", actor);
const allRuns = () => runs.listRuns({ limit: 200 }).runs;
const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

describe("spawn", () => {
  it("fires after the write, with the employee, the rendered prompt and the payload", async () => {
    config = { hooks: [reviewHook()] };
    const id = labelled();
    await flush();
    expect(allRuns()).toEqual([]);
    toReview(id);
    expect(spawnMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("ok"));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const input = spawnMock.mock.calls[0][1];
    expect(input).toMatchObject({ employee: "merger" });
    expect(input).not.toHaveProperty("parentSessionId");
    expect(input.provenance.source).toBe("hook");
    expect(input.provenance.sourceRef).toMatch(/^hook:bhf_[0-9a-f]{12}$/);
    expect(input.prompt.startsWith(`${id} moved executing -> in_review\n\n\`\`\`json\n`)).toBe(true);
    const run = runs.getRun(allRuns()[0].id)!;
    expect(run).toMatchObject({ hook: "review-merge", event: "todo.status_changed", todoId: id, action: "spawn", status: "ok", sessionId: "spawned-1", chain: ["review-merge"] });
    expect(run.fireId).toBe(input.provenance.sourceRef.slice("hook:".length));
    expect(run.payload).toMatchObject({ fireId: run.fireId, hook: "review-merge", from: "executing", to: "in_review", todo: { id, labels: ["auto-merge"] }, chain: ["review-merge"] });
    expect(input.prompt).toContain(`"fireId": "${run.fireId}"`);
    expect(emitted.map((frame) => frame.status)).toEqual(["running", "ok"]);
  });

  it("passes engine, model and effort through", async () => {
    config = { hooks: [reviewHook({ action: { spawn: { employee: "merger", engine: "codex", model: "m", effortLevel: "low" } } })] };
    toReview(labelled());
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(spawnMock.mock.calls[0][1]).toMatchObject({ engine: "codex", model: "m", effortLevel: "low" });
    expect(spawnMock.mock.calls[0][1].prompt).toContain('Board hook "review-merge" fired on todo.status_changed');
  });

  it("does not fire for a Todo the matcher rejects, a disabled hook, or another event", async () => {
    config = { hooks: [reviewHook({ enabled: false }), reviewHook({ name: "other-label", match: { label: "nope" } }), reviewHook({ name: "assigned", event: "todo.assigned" })] };
    toReview(labelled());
    await flush();
    await flush();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(allRuns()).toEqual([]);
  });

  it("reads hooks from the live config on every event", async () => {
    const id = labelled();
    toReview(id);
    await flush();
    expect(allRuns()).toEqual([]);
    config = { hooks: [reviewHook()] };
    transitions.transition(id, "executing", "operator", { human: true });
    toReview(id);
    await vi.waitFor(() => expect(allRuns()).toHaveLength(1));
  });

  it("skips a bad hook and still runs the others", async () => {
    config = { hooks: [{ name: "BAD", event: "todo.status_changed", action: {} }, reviewHook()] };
    toReview(labelled());
    await vi.waitFor(() => expect(allRuns()).toHaveLength(1));
    expect(allRuns()[0].hook).toBe("review-merge");
  });

  it("records an error when the spawn is refused, throws, or comes back not started", async () => {
    config = { hooks: [reviewHook()] };
    spawnMock.mockResolvedValueOnce({ ok: false, error: 'unknown employee "merger"' });
    toReview(labelled("a"));
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("error"));
    expect(allRuns()[0].error).toBe('unknown employee "merger"');
    spawnMock.mockRejectedValueOnce(new Error("kaboom token=abcd1234secret"));
    toReview(labelled("b"));
    await vi.waitFor(() => expect(allRuns().filter((run) => run.status === "error")).toHaveLength(2));
    expect(allRuns()[0].error).toBe("kaboom token=[REDACTED]");
    spawnMock.mockResolvedValueOnce({ ok: true, dispatched: false, session: { id: "s-late", lastError: "engine not available" } });
    toReview(labelled("c"));
    await vi.waitFor(() => expect(allRuns().filter((run) => run.status === "error")).toHaveLength(3));
    expect(allRuns()[0]).toMatchObject({ error: "engine not available", sessionId: "s-late" });
  });

  it("never blocks the move, whatever the spawn does", async () => {
    config = { hooks: [reviewHook()] };
    spawnMock.mockReturnValue(new Promise(() => undefined));
    const id = labelled();
    expect(toReview(id).item.status).toBe("in_review");
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("running"));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("committed writes only", () => {
  it("fires nothing for a write an enclosing transaction rolled back", async () => {
    config = { hooks: [reviewHook({ event: ["todo.created", "todo.status_changed"], match: undefined })] };
    const id = labelled();
    await vi.waitFor(() => expect(allRuns().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(spawnMock.mock.calls.length).toBeGreaterThan(0));
    spawnMock.mockClear();
    db.prepare("DELETE FROM board_hook_runs").run();
    expect(() => db.transaction(() => {
      toReview(id);
      store.createWorkItem({ title: "never" });
      throw new Error("roll back");
    })()).toThrow("roll back");
    await flush();
    await flush();
    expect(allRuns()).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
    db.transaction(() => { toReview(id); })();
    await vi.waitFor(() => expect(allRuns()).toHaveLength(1));
  });
});

describe("notify", () => {
  it("posts the rendered, redacted text through the connector", async () => {
    connectors.set("telegram", { sendMessage: async (target: unknown, text: string) => { sent.push({ target, text }); return "m1"; } });
    config = { hooks: [reviewHook({ action: { notify: { connector: "telegram", channel: 123456, thread: "7", text: "{{todo.id}} waiting; key=sk-abcdefghijklmnop" } } })] };
    const id = labelled();
    toReview(id);
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("ok"));
    expect(sent).toEqual([{ target: { channel: "123456", thread: "7" }, text: `${id} waiting; key=[REDACTED]` }]);
    expect(allRuns()[0]).toMatchObject({ action: "notify", status: "ok" });
  });

  it("records an error for a connector that is not configured or that rejects", async () => {
    config = { hooks: [reviewHook({ action: { notify: { connector: "telegram", channel: "1", text: "x" } } })] };
    toReview(labelled("a"));
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("error"));
    expect(allRuns()[0].error).toBe('no connector "telegram" is configured');
    connectors.set("telegram", { sendMessage: async () => { throw new Error("network down"); } });
    toReview(labelled("b"));
    await vi.waitFor(() => expect(allRuns().filter((run) => run.status === "error")).toHaveLength(2));
    expect(allRuns()[0].error).toBe("network down");
  });
});

describe("one firing, several actions", () => {
  it("writes a row per action under one fire id and runs them independently", async () => {
    connectors.set("telegram", { sendMessage: async (_t: unknown, text: string) => { sent.push({ target: _t, text }); } });
    config = { hooks: [reviewHook({ action: { spawn: { employee: "merger" }, notify: { connector: "telegram", channel: "1", text: "hi" }, command: { run: "exit 1", cwd: work } } })] };
    spawnMock.mockReturnValue(new Promise(() => undefined));
    toReview(labelled());
    await vi.waitFor(() => expect(allRuns()).toHaveLength(3));
    await vi.waitFor(() => expect(allRuns().filter((run) => run.status !== "running")).toHaveLength(2));
    const byAction = Object.fromEntries(allRuns().map((run) => [run.action, run]));
    expect(byAction.spawn.status).toBe("running");
    expect(byAction.command.status).toBe("error");
    expect(byAction.notify.status).toBe("ok");
    expect(new Set(allRuns().map((run) => run.fireId)).size).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("gives each hook on the same event its own fire", async () => {
    config = { hooks: [reviewHook(), reviewHook({ name: "second" })] };
    toReview(labelled());
    await vi.waitFor(() => expect(allRuns()).toHaveLength(2));
    expect(new Set(allRuns().map((run) => run.fireId)).size).toBe(2);
  });
});
