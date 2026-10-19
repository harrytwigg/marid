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
let registry: typeof import("../../sessions/registry.js");
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
  registry = await import("../../sessions/registry.js");
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
const runsFor = (todo: string) => runs.listRuns({ todo, limit: 200 }).runs;
const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

describe("command", () => {
  const command = (run: string, extra: Record<string, unknown> = {}) => reviewHook({ action: { command: { run, cwd: work, ...extra } } });

  it("runs under /bin/sh with the payload on stdin and the hook environment, and keeps the output tail", async () => {
    const out = path.join(work, "stdin.json");
    config = { hooks: [command(`cat > ${out}; echo "$JINN_HOOK_NAME|$JINN_HOOK_EVENT|$JINN_HOOK_TODO_ID|$JINN_HOOK_FROM|$JINN_HOOK_TO|$JINN_HOOK_ACTOR|$JINN_HOOK_CHAIN|$JINN_HOOK_FIRE_ID"; echo "$JINN_HOOK_PAYLOAD" > ${out}.env; echo oops 1>&2`)] };
    const id = labelled();
    toReview(id);
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("ok"));
    const run = runs.getRun(allRuns()[0].id)!;
    expect(run).toMatchObject({ action: "command", exitCode: 0 });
    expect(run.output).toBe(`review-merge|todo.status_changed|${id}|executing|in_review|operator|review-merge|${run.fireId}\noops\n`);
    const stdin = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(stdin).toMatchObject({ hook: "review-merge", fireId: run.fireId, todo: { id } });
    expect(JSON.parse(fs.readFileSync(`${out}.env`, "utf8"))).toEqual(stdin);
  });

  it("records a non-zero exit as an error with the exit code and the output", async () => {
    config = { hooks: [command("echo failing; exit 3")] };
    toReview(labelled());
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("error"));
    expect(runs.getRun(allRuns()[0].id)).toMatchObject({ exitCode: 3, error: "exited with code 3", output: "failing\n" });
  });

  it("redacts and truncates the output to the last 4 KB", async () => {
    config = { hooks: [command(`echo "API_TOKEN=supersecretvalue"; i=0; while [ $i -lt 600 ]; do echo "line-$i-xxxxxxxxxxxx"; i=$((i+1)); done`)] };
    toReview(labelled());
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("ok"));
    const output = runs.getRun(allRuns()[0].id)!.output!;
    expect(output.length).toBeLessThanOrEqual(4096);
    expect(output).toContain("line-599-xxxxxxxxxxxx");
    expect(output).not.toContain("line-0-");
    config = { hooks: [command(`echo "API_TOKEN=supersecretvalue"`)] };
    toReview((() => { const id = labelled("b"); return id; })());
    await vi.waitFor(() => expect(allRuns().filter((run) => run.status === "ok")).toHaveLength(2));
    expect(runs.getRun(allRuns()[0].id)!.output).toBe("API_TOKEN=[REDACTED]\n");
  });

  it("refuses a command the command policy blocks", async () => {
    config = { hooks: [command("rm -rf / --no-preserve-root")] };
    toReview(labelled());
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("error"));
    expect(allRuns()[0].error).toMatch(/^refused by the command policy: /);
  });

  it("leaves a hanging command running without delaying the move, and stopping the hooks ends it", async () => {
    config = { hooks: [command("sleep 1000")] };
    const id = labelled();
    expect(toReview(id).item.status).toBe("in_review");
    await vi.waitFor(() => expect(allRuns()[0]?.status).toBe("running"));
    await flush();
    expect(allRuns()[0].status).toBe("running");
    hooks.stopBoardHooks();
    await vi.waitFor(() => expect(runs.getRun(allRuns()[0].id)?.status).toBe("error"));
    expect(runs.getRun(allRuns()[0].id)!.error).toBe("killed by SIGTERM");
  });
});

describe("loop guard", () => {
  /** A hook-spawned session and the run row its fire left, as the dispatcher writes them. */
  function hookSession(hook: string, chain: string[], parentSessionId?: string) {
    const fireId = `bhf_${Math.random().toString(16).slice(2, 14)}`;
    runs.insertRun({ fireId, hook, event: "todo.status_changed", eventId: "wie_0", todoId: "PLA-1", action: "spawn", status: "ok", payload: {}, chain });
    return registry.createSession({ engine: "claude", source: "hook", sourceRef: `hook:${fireId}`, employee: "merger", parentSessionId });
  }

  it("suppresses a hook already in the chain of the session that moved the Todo", async () => {
    config = { hooks: [reviewHook()] };
    const session = hookSession("review-merge", ["review-merge"]);
    const id = labelled();
    toReview(id, `session:${session.id}`);
    await vi.waitFor(() => expect(runsFor(id)).toHaveLength(1));
    const suppressed = runsFor(id)[0];
    expect(suppressed.status).toBe("suppressed");
    expect(suppressed).toMatchObject({ action: "none", chain: ["review-merge"] });
    expect(suppressed.error).toMatch(/already in this event's chain/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("covers descendants of a hook session, and lets an unrelated hook through", async () => {
    config = { hooks: [reviewHook(), reviewHook({ name: "audit" })] };
    const root = hookSession("review-merge", ["review-merge"]);
    const child = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:child", employee: "dev", parentSessionId: root.id });
    const id = labelled();
    toReview(id, `session:${child.id}`);
    await vi.waitFor(() => expect(runsFor(id).filter((run) => run.status !== "running")).toHaveLength(2));
    expect(runsFor(id).find((run) => run.hook === "review-merge")!.status).toBe("suppressed");
    const audit = runsFor(id).find((run) => run.hook === "audit")!;
    expect(audit.status).toBe("ok");
    expect(audit.chain).toEqual(["review-merge", "audit"]);
  });

  it("fires a hook that allows re-entry, extending the chain", async () => {
    config = { hooks: [reviewHook({ allowReentry: true })] };
    const session = hookSession("review-merge", ["review-merge"]);
    const id = labelled();
    toReview(id, `session:${session.id}`);
    await vi.waitFor(() => expect(runsFor(id)[0]?.status).toBe("ok"));
    expect(runsFor(id)[0].chain).toEqual(["review-merge", "review-merge"]);
  });

  it("caps the chain at five hooks even with re-entry", async () => {
    config = { hooks: [reviewHook({ allowReentry: true })] };
    const session = hookSession("e", ["a", "b", "c", "d", "e"]);
    const id = labelled();
    toReview(id, `session:${session.id}`);
    await vi.waitFor(() => expect(runsFor(id)[0]?.status).toBe("suppressed"));
    expect(runsFor(id)[0].error).toMatch(/limit is 5/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("carries the chain through a comment authored by a hook session", async () => {
    config = { hooks: [reviewHook({ event: "todo.commented", match: undefined })] };
    const session = hookSession("review-merge", ["review-merge"]);
    const comments = await import("../../work-items/comments.js");
    const id = labelled();
    comments.addComment({ workItemId: id, body: "from the hook session", author: "merger", authorKind: "employee", sessionId: session.id });
    await vi.waitFor(() => expect(runsFor(id)[0]?.status).toBe("suppressed"));
  });
});

describe("boot", () => {
  it("marks rows a previous process left running as interrupted", () => {
    const id = runs.insertRun({ fireId: "bhf_old", hook: "h", event: "todo.created", eventId: "wie_1", todoId: "PLA-1", action: "command", status: "running", payload: {}, chain: [] });
    hooks.installBoardHooks(context);
    expect(runs.getRun(id)!.status).toBe("interrupted");
  });
});
