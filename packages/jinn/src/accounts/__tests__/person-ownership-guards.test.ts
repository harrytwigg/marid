import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_TOKEN } from "./accounts-harness.js";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/* Who may move the person responsible, and where a person may be chosen: an agent never moves it, a member never takes the
 * operator's place, and the person must have access to the board the Todo is on after the edit. */

let h: BoardHarness;
let collab: Member;
let designer: Member;
let store: typeof import("../../work-items/store.js");
let transitions: typeof import("../../work-items/transitions.js");
let walk: typeof import("../../board-walk/board.js");

const mk = () => store.createWorkItem({ title: "A Todo", department: "ops" });
const stored = (id: string) => h.db.prepare("SELECT person FROM todo_people WHERE todo_id = ?").pluck().get(id) as string | undefined;
const personEvents = (id: string) => store.listWorkItemEvents(id).filter((event) => event.kind === "person_changed");
const patch = (id: string, body: Record<string, unknown>) => h.operator("PATCH", `/api/work-items/${id}`, { ...body, expectedVersion: store.getWorkItem(id)!.version });
const putPerson = (m: Member, id: string, person: unknown) => h.as(m, "PUT", `/api/member/todos/${id}/person`, { person });
/** The operator's desk as the gateway builds it for `needsAttentionFor=me`: the org root's queue plus the operator's. */
const desk = async () => (await h.operator("GET", "/api/work-items?needsAttentionFor=me&limit=200")).body.workItems.map((row: { id: string }) => row.id) as string[];
/** A Todo an agent has handed to the operator while a member is the person: `assignee = '@operator'` beside the member's row. */
const handedOver = async () => {
  const todo = mk();
  store.updateWorkItem(todo.id, { assignee: "alice" });
  transitions.transition(todo.id, "blocked", "operator", { human: true, detail: { note: "Needs a decision" } });
  await putPerson(collab, todo.id, `user:${collab.userId}`);
  expect(await desk()).not.toContain(todo.id); // alice's own blocked Todo: hers, not the operator's
  // Through the pen, which leaves the department alone (the assign route derives it, taking the Todo off the member's board).
  store.updateWorkItem(todo.id, { assignee: "@operator" });
  expect(store.getWorkItem(todo.id)).toMatchObject({ assignee: "@operator", humanAssignee: `user:${collab.userId}`, department: "ops" });
  return todo.id;
};

/** An agent's tool call: a real session and the capability the gateway minted for it, as an engine passes them. */
const tool = async (name: string, args: Record<string, unknown>) => {
  const { buildWorkItemTools } = await import("../../mcp/work-item-tools.js");
  const { createSession } = await import("../../sessions/registry.js");
  const { ensureSessionCapability } = await import("../../mcp/identity.js");
  const session = createSession({ engine: "claude", source: "web", sourceRef: "agent", employee: "alice" } as never);
  const found = buildWorkItemTools().find((candidate) => candidate.name === name)!;
  return found.handler(args, {
    gatewayUrl: h.baseUrl, token: GATEWAY_TOKEN, callerSessionId: session.id, sessionCapability: ensureSessionCapability(session.id),
  } as never) as Promise<any>;
};

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  walk = await import("../../board-walk/board.js");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  designer = await h.join("designer@example.test", "collaborator", "design", "Dee Designer");
  await h.join("collab@example.test", "collaborator", "design", "Casey Collab"); // Casey holds both boards
}, 60_000);
afterAll(async () => { await h.close(); });

describe("an agent handing a Todo to the operator", () => {
  it("never changes the person a member chose: the row stays, and the Todo is still on the operator's desk", async () => {
    const todo = mk();
    store.updateWorkItem(todo.id, { assignee: "alice" });
    transitions.transition(todo.id, "blocked", "operator", { human: true, detail: { note: "Needs a decision" } });
    expect((await putPerson(collab, todo.id, `user:${collab.userId}`)).status).toBe(200);
    const before = personEvents(todo.id).length;

    await tool("assign_work_item", { id: todo.id, assignee: "@operator" });

    expect(store.getWorkItem(todo.id)).toMatchObject({ assignee: "@operator", humanAssignee: `user:${collab.userId}` });
    expect(stored(todo.id)).toBe(`user:${collab.userId}`);
    expect(personEvents(todo.id)).toHaveLength(before);
    expect(await desk()).toContain(todo.id);

    // The operator handing it back to the agent finds the person where the member left it.
    await h.operator("POST", `/api/work-items/${todo.id}/assign`, { assignee: "alice" });
    expect(store.getWorkItem(todo.id)).toMatchObject({ assignee: "alice", humanAssignee: `user:${collab.userId}` });
  });

  it("lets the operator rename the person without dropping the operator: the Todo still waits on them", async () => {
    const id = await handedOver();
    const peer = await h.join("renamed@example.test", "collaborator", "ops", "Rae Renamed");
    expect(await desk()).toContain(id);
    const reply = await patch(id, { humanAssignee: `user:${peer.userId}` });
    expect(reply.body.workItem).toMatchObject({ assignee: "@operator", humanAssignee: `user:${peer.userId}` });
    expect(walk.noAutoStartReason(store.getWorkItem(id)!)).toBe("assigned to the operator");
    expect(await desk()).toContain(id);
    expect(personEvents(id).at(-1)?.detail).toEqual({ from: `user:${collab.userId}`, to: `user:${peer.userId}` });
  });

  it("clearing that person leaves the operator as the person, still waiting on them; clearing again clears the assignee", async () => {
    const id = await handedOver();
    expect((await patch(id, { humanAssignee: null })).body.workItem).toMatchObject({ assignee: "@operator", humanAssignee: "@operator" });
    expect(stored(id)).toBeUndefined();
    expect(walk.noAutoStartReason(store.getWorkItem(id)!)).toBe("assigned to the operator");
    expect((await patch(id, { humanAssignee: null })).body.workItem).toMatchObject({ assignee: null, humanAssignee: null });
  });

  it("lets a member rename the person there (only the row moves) but never clear it, which would name the operator", async () => {
    const id = await handedOver();
    const peer = await h.join("peer@example.test", "collaborator", "ops", "Pia Peer");
    const before = JSON.stringify([store.getWorkItem(id), stored(id), personEvents(id)]);
    const cleared = await putPerson(collab, id, null);
    expect([cleared.status, cleared.body.code]).toEqual([403, "person_operator_only"]);
    expect(JSON.stringify([store.getWorkItem(id), stored(id), personEvents(id)])).toBe(before);

    const { version, assignee, department } = store.getWorkItem(id)!;
    const renamed = await putPerson(collab, id, `user:${peer.userId}`);
    expect(renamed.status).toBe(200);
    expect(store.getWorkItem(id)).toMatchObject({ assignee, department, humanAssignee: `user:${peer.userId}`, version: version + 1 });
    expect(stored(id)).toBe(`user:${peer.userId}`);
    expect(await desk()).toContain(id);
  });
});

describe("the person must have access to the board the Todo is on after the edit", () => {
  it("an edit that moves a root to another board is judged against that board", async () => {
    const todo = mk();
    const refused = await patch(todo.id, { department: "design", humanAssignee: `user:${(await h.join("opsonly@example.test", "collaborator", "ops", "Olly Ops")).userId}` });
    expect([refused.status, refused.body.code]).toEqual([422, "todo_invalid_person"]);
    expect(store.getWorkItem(todo.id)).toMatchObject({ department: "ops", humanAssignee: null });
    const allowed = await patch(todo.id, { department: "design", humanAssignee: `user:${designer.userId}` });
    expect(allowed.status).toBe(200);
    expect(allowed.body.workItem).toMatchObject({ department: "design", humanAssignee: `user:${designer.userId}` });
  });
});

describe("a patch that contradicts itself", () => {
  it("is refused 422 instead of silently rewritten", async () => {
    const todo = mk();
    const reply = await patch(todo.id, { assignee: "@operator", humanAssignee: `user:${collab.userId}` });
    expect([reply.status, reply.body.code]).toEqual([422, "todo_invalid_ownership"]);
    expect(store.getWorkItem(todo.id)).toMatchObject({ assignee: null, humanAssignee: null });
  });

  it("lets a consistent pair through", async () => {
    const todo = mk();
    const reply = await patch(todo.id, { assignee: "alice", humanAssignee: `user:${collab.userId}` });
    expect(reply.body.workItem).toMatchObject({ assignee: "alice", humanAssignee: `user:${collab.userId}` });
  });
});

describe("GET /api/member/people?board=", () => {
  it("lists only the people on that board, and answers 404 for a board the member does not hold", async () => {
    const all = (await h.as(collab, "GET", "/api/member/people")).body.people.map((person: any) => person.id);
    const ops = (await h.as(collab, "GET", "/api/member/people?board=ops")).body.people.map((person: any) => person.id);
    expect(all).toContain(designer.userId);
    expect(ops).toContain(collab.userId);
    expect(ops).not.toContain(designer.userId);
    expect((await h.as(designer, "GET", "/api/member/people?board=ops")).status).toBe(404);
  });
});
