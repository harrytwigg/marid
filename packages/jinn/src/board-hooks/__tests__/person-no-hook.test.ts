import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempHome } from "./db-fixtures.js";

useTempHome("jinn-board-hooks-person-");

const spawnMock = vi.fn();
vi.mock("../../gateway/spawn-session.js", () => ({ spawnSession: (...args: unknown[]) => spawnMock(...args) }));

type Db = ReturnType<typeof import("../../shared/db.js").initDb>;
let store: typeof import("../../work-items/store.js");
let hooks: typeof import("../index.js");
let runs: typeof import("../run-store.js");
let db: Db;
let config: { hooks?: unknown[] } = {};

const context = { getConfig: () => config, emit: () => undefined, connectors: new Map() } as never;
const MEMBER = "user:usr_0123456789ab";
const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
const EVENTS = ["todo.created", "todo.commented", "todo.status_changed", "todo.assigned", "todo.delegated", "todo.dispatched"];
const hook = (event: string) => ({ name: `all-${event.replace(".", "-")}`, event, action: { spawn: { employee: "merger", prompt: "{{todo.id}} saw an event" } } });
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  hooks = await import("../index.js");
  runs = await import("../run-store.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  config = { hooks: EVENTS.map(hook) };
  spawnMock.mockReset();
  spawnMock.mockResolvedValue({ ok: true, dispatched: true, session: { id: "spawned-1" } });
  db.prepare("DELETE FROM board_hook_runs").run();
  hooks.installBoardHooks(context);
});
afterEach(() => hooks.stopBoardHooks());
afterAll(() => hooks.stopBoardHooks());

const setPerson = (id: string, humanAssignee: string | null, actor: string) =>
  store.updateWorkItemConditional(id, { humanAssignee }, { expectedVersion: store.getWorkItem(id)!.version, actor })!.item;

describe("setting or clearing the person responsible wakes nothing", () => {
  it("fires no board hook, whoever sets it, and starts no session or dispatch", async () => {
    const item = store.createWorkItem({ title: "A Todo", department: "ops" });
    await flush();
    spawnMock.mockClear();
    db.prepare("DELETE FROM board_hook_runs").run();
    const before = { sessions: count("SELECT COUNT(*) AS n FROM sessions"), dispatch: count("SELECT COUNT(*) AS n FROM work_item_dispatch"), status: store.getWorkItem(item.id)!.status };

    setPerson(item.id, "@operator", "operator");
    setPerson(item.id, MEMBER, "operator");
    setPerson(item.id, null, MEMBER);
    setPerson(item.id, MEMBER, MEMBER);
    await flush();

    expect(store.listWorkItemEvents(item.id).filter((event) => event.kind === "person_changed")).toHaveLength(4);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(runs.listRuns({ limit: 50 }).runs).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(before.sessions);
    expect(count("SELECT COUNT(*) AS n FROM work_item_dispatch")).toBe(before.dispatch);
    expect(store.getWorkItem(item.id)).toMatchObject({ status: before.status, assignee: null });
  });

  it("clearing the operator out of a Todo assigned to them fires no assignment hook either", async () => {
    const item = store.createWorkItem({ title: "Needs the operator", department: "ops" });
    store.updateWorkItem(item.id, { assignee: "@operator" });
    await flush();
    spawnMock.mockClear();
    const cleared = setPerson(item.id, null, "operator");
    await flush();
    expect(cleared).toMatchObject({ assignee: null, humanAssignee: null });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("the hooks are live: an agent assignment on the same Todo does fire", async () => {
    const item = store.createWorkItem({ title: "A Todo", department: "ops" });
    await flush();
    spawnMock.mockClear();
    store.updateWorkItemConditional(item.id, { assignee: "merger" }, { expectedVersion: store.getWorkItem(item.id)!.version, actor: "operator" });
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
