import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startBoardHarness, type BoardHarness } from "./board-harness.js";

/* Choosing yourself as the person, with no agent, keeps today's meaning by storage: `assignee = '@operator'`. Driven end to
 * end through the operator's edit route, against a twin Todo given to the operator the way it always was (the assign route). */

let h: BoardHarness;
let store: typeof import("../../work-items/store.js");
let transitions: typeof import("../../work-items/transitions.js");
let walk: typeof import("../../board-walk/board.js");
let children: typeof import("../../work-items/quiet-children.js");
let quiet: typeof import("../../work-items/quiet-watch.js");

const mk = (status: "backlog" | "blocked" | "executing") => {
  const item = store.createWorkItem({ title: `A ${status} Todo`, department: "ops" });
  if (status === "executing") transitions.transition(item.id, "executing", "operator", { human: true });
  if (status === "blocked") transitions.transition(item.id, "blocked", "operator", { human: true, detail: { note: "Waiting on a decision" } });
  return item.id;
};
const detail = async (id: string) => (await h.operator("GET", `/api/work-items/${id}`)).body;
const chooseSelf = (id: string) => h.operator("PATCH", `/api/work-items/${id}`, { humanAssignee: "@operator", expectedVersion: store.getWorkItem(id)!.version });
const patch = (id: string, body: Record<string, unknown>) => h.operator("PATCH", `/api/work-items/${id}`, { ...body, expectedVersion: store.getWorkItem(id)!.version });
/** The operator's desk as the gateway builds it for `needsAttentionFor=me`: the org root's queue plus the operator's. */
const desk = async () => (await h.operator("GET", "/api/work-items?needsAttentionFor=me&limit=200")).body.workItems.map((row: { id: string }) => row.id) as string[];
const stored = (id: string) => h.db.prepare("SELECT person FROM todo_people WHERE todo_id = ?").pluck().get(id) as string | undefined;

/** What every reader of `assignee` decides about a Todo. */
async function treatment(id: string) {
  const read = await detail(id);
  const item = store.getWorkItem(id)!;
  return {
    assignee: item.assignee,
    attentionLane: read.attentionLane,
    reviewAddressee: read.reviewAddressee,
    autoStartRefusal: walk.noAutoStartReason(item) ?? null,
    walkWillStart: children.walkWillStart({ id, assignee: item.assignee }),
  };
}

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  walk = await import("../../board-walk/board.js");
  children = await import("../../work-items/quiet-children.js");
  quiet = await import("../../work-items/quiet-watch.js");
}, 60_000);
afterAll(async () => { await h.close(); });

describe("the operator chooses themselves as the person on an unassigned Todo", () => {
  it("stores the assignee the assign route stores, with no row, and every reader decides the same", async () => {
    for (const status of ["backlog", "blocked"] as const) {
      const viaPerson = mk(status);
      const twin = mk(status);
      expect((await chooseSelf(viaPerson)).status).toBe(200);
      expect((await h.operator("POST", `/api/work-items/${twin}/assign`, { assignee: "@operator" })).status).toBe(200);
      expect(store.getWorkItem(viaPerson)).toMatchObject({ assignee: "@operator", humanAssignee: "@operator" });
      expect(stored(viaPerson)).toBeUndefined();
      expect(await treatment(viaPerson)).toEqual(await treatment(twin));
    }
  });

  it("the board walk refuses to start it and an operator's blocked Todo is on the operator's desk, as for the twin", async () => {
    const viaPerson = mk("blocked");
    const twin = mk("blocked");
    await chooseSelf(viaPerson);
    await h.operator("POST", `/api/work-items/${twin}/assign`, { assignee: "@operator" });
    const offDesk = mk("blocked");
    await patch(offDesk, { assignee: "alice" }); // an agent's blocked Todo is the agent's, not the operator's
    const onDesk = await desk();
    expect(onDesk).toEqual(expect.arrayContaining([viaPerson, twin]));
    expect(onDesk).not.toContain(offDesk);
    expect((await treatment(viaPerson)).autoStartRefusal).toBe("assigned to the operator");
  });

  it("quiet-watch treats it as it treats the twin: an operator's own Todo is nobody's to nudge", async () => {
    const viaPerson = mk("executing");
    const twin = mk("executing");
    await chooseSelf(viaPerson);
    await h.operator("POST", `/api/work-items/${twin}/assign`, { assignee: "@operator" });
    const redispatch = vi.fn();
    const acted = quiet.sweepQuietTodos({
      isEmployee: (name) => name === "alice" || name === "mason",
      redispatch,
      windows: () => ({ afterMs: 1, backgroundTaskMs: 1 }),
      now: () => Date.now() + 14 * 24 * 3600 * 1000,
    });
    expect(acted).toBe(0);
    expect(redispatch).not.toHaveBeenCalled();
    expect(await treatment(viaPerson)).toEqual(await treatment(twin));
  });

  it("an agent set over it keeps the operator as the person; clearing the agent puts the Todo back on the operator's desk, as the twin is", async () => {
    const viaPerson = mk("blocked");
    const twin = mk("blocked");
    await chooseSelf(viaPerson);
    await h.operator("POST", `/api/work-items/${twin}/assign`, { assignee: "@operator" });

    const withAgent = await patch(viaPerson, { assignee: "alice" });
    expect(withAgent.body.workItem).toMatchObject({ assignee: "alice", humanAssignee: "@operator" });
    expect(stored(viaPerson)).toBe("@operator");
    expect((await treatment(viaPerson)).autoStartRefusal).not.toBe("assigned to the operator");
    expect(await desk()).not.toContain(viaPerson);

    const cleared = await patch(viaPerson, { assignee: null });
    expect(cleared.body.workItem).toMatchObject({ assignee: "@operator", humanAssignee: "@operator" });
    expect(stored(viaPerson)).toBeUndefined();
    expect(await treatment(viaPerson)).toEqual(await treatment(twin));
    expect(await desk()).toContain(viaPerson);
  });

  it("the assign route settles the person the same way: an agent over @operator keeps the operator as the person", async () => {
    const todo = mk("backlog");
    await chooseSelf(todo);
    expect((await h.operator("POST", `/api/work-items/${todo}/assign`, { assignee: "alice" })).status).toBe(200);
    expect(store.getWorkItem(todo)).toMatchObject({ assignee: "alice", humanAssignee: "@operator" });
    expect(stored(todo)).toBe("@operator");
  });

  it("clearing the person of a Todo that waits on the operator clears the assignee; unassigned and blocked, it stays on the desk", async () => {
    const todo = mk("blocked");
    await chooseSelf(todo);
    expect((await patch(todo, { humanAssignee: null })).body.workItem).toMatchObject({ assignee: null, humanAssignee: null });
    expect(await desk()).toContain(todo); // unassigned blocked still counts as the operator's
    expect(stored(todo)).toBeUndefined();
  });
});
