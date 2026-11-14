import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempHome } from "./db-fixtures.js";

useTempHome("hundredfold-board-hooks-member-");

const spawnMock = vi.fn();
vi.mock("../../gateway/spawn-session.js", () => ({ spawnSession: (...args: unknown[]) => spawnMock(...args) }));

type Db = ReturnType<typeof import("../../shared/db.js").initDb>;
let store: typeof import("../../work-items/store.js");
let comments: typeof import("../../work-items/comments.js");
let transitions: typeof import("../../work-items/transitions.js");
let hooks: typeof import("../index.js");
let actors: typeof import("../actor.js");
let runs: typeof import("../run-store.js");
let db: Db;
let config: { hooks?: unknown[] } = {};

const context = { getConfig: () => config, emit: () => undefined, connectors: new Map() } as never;
const MEMBER = "user:usr_0123456789ab";
const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

const hook = (event: string) => ({ name: `all-${event.replace(".", "-")}`, event, action: { spawn: { employee: "merger", prompt: "{{todo.id}} saw an event" } } });

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  transitions = await import("../../work-items/transitions.js");
  hooks = await import("../index.js");
  actors = await import("../actor.js");
  runs = await import("../run-store.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  config = { hooks: [hook("todo.created"), hook("todo.commented"), hook("todo.status_changed")] };
  spawnMock.mockReset();
  spawnMock.mockResolvedValue({ ok: true, dispatched: true, session: { id: "spawned-1" } });
  db.prepare("DELETE FROM board_hook_runs").run();
  hooks.installBoardHooks(context);
});
afterEach(() => hooks.stopBoardHooks());
afterAll(() => hooks.stopBoardHooks());

/** A Todo stored the way a member's create is: `connector` source, `user:` ref and creator. */
const memberTodo = (title = "T") => store.createWorkItem({ title, department: "ops", source: "connector", sourceRef: `${MEMBER}:${Math.random().toString(16).slice(2, 14)}`, createdBy: MEMBER });

describe("board hooks and board members", () => {
  it("a match-all todo.created hook fires nothing for a member create, and does for the operator's", async () => {
    memberTodo();
    await flush();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(runs.listRuns({ limit: 50 }).runs).toEqual([]);
    store.createWorkItem({ title: "operator's" });
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("suppression keys on the resolved actor: the created event records the source, not the member", () => {
    const item = memberTodo();
    const created = store.listWorkItemEvents(item.id).find((event) => event.kind === "created")!;
    expect(created.actor).toBe("connector");
    expect(actors.creatorOf(created, item)).toMatchObject({ kind: "member", member: "usr_0123456789ab" });
    expect(actors.creatorOf(created, item).kind).not.toBe("operator");
  });

  it("a member's comment and status move fire nothing; another plugin's connector Todo is not mistaken for a member", async () => {
    const item = store.createWorkItem({ title: "plugin made", source: "connector", sourceRef: "plugin:x:1", createdBy: "plugin:x" });
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1); // a plugin's create is not a member's
    spawnMock.mockClear();
    comments.addComment({ workItemId: item.id, body: "from a member", author: MEMBER, authorKind: "system" });
    transitions.transition(item.id, "done", MEMBER);
    await flush();
    expect(spawnMock).not.toHaveBeenCalled();
    comments.addComment({ workItemId: item.id, body: "from the operator", author: "operator", authorKind: "operator" });
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("actorOf reads a member from a comment's author and an event's actor, never as the operator", () => {
    const item = memberTodo();
    const comment = comments.addComment({ workItemId: item.id, body: "c", author: MEMBER, authorKind: "system" });
    const event = store.listWorkItemEvents(item.id).find((e) => e.kind === "comment_added")!;
    expect(actors.actorOf(event, comment)).toMatchObject({ kind: "member", raw: MEMBER });
    const moved = transitions.transition(item.id, "done", MEMBER).event!;
    expect(actors.actorOf(moved)).toMatchObject({ kind: "member", raw: MEMBER });
  });
});
