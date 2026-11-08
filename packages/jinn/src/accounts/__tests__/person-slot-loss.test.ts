import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_TOKEN } from "./accounts-harness.js";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/* No write clears a slot the writer did not name without saying so. Each path that can is driven through its real route
 * and its event is read back: the person slot clearing the operator out of `assignee` records `assigneeCleared`; the
 * agent slot clearing an `@operator` assignee with no row (the operator as the person, by storage) records
 * `personCleared`; removing a user records `reason: "person_removed"` on every Todo that named them. Assigning to the
 * operator a Todo with no person fills the slot (the operator reads as the person) and records `{ from: null, to:
 * "@operator" }`. Every other agent-slot write leaves the person alone (no `person_changed` event, the person as read
 * unchanged), by any route: the operator's pen, the assign route, an agent's assign tool, a delegation and an agent's
 * delegate_task tool. */

let h: BoardHarness;
let collab: Member;
let peer: Member;
let store: typeof import("../../work-items/store.js");

const OP = "@operator";
const mk = () => store.createWorkItem({ title: "A Todo", department: "ops" }).id;
const patch = (id: string, body: Record<string, unknown>) => h.operator("PATCH", `/api/work-items/${id}`, { ...body, expectedVersion: store.getWorkItem(id)!.version });
const personEvents = (id: string) => store.listWorkItemEvents(id).filter((event) => event.kind === "person_changed");
const lastPersonEvent = (id: string) => personEvents(id).at(-1)?.detail;
const putPerson = (m: Member, id: string, person: unknown) => h.as(m, "PUT", `/api/member/todos/${id}/person`, { person });

/** A Todo in a given state of the two slots, reached through the pen as the operator would reach it. */
async function inState(assignee: string | null, person: string | null): Promise<string> {
  const id = mk();
  if (person === OP) await patch(id, { humanAssignee: OP });
  else if (person) await patch(id, { humanAssignee: person });
  if (assignee) store.updateWorkItem(id, { assignee });
  expect(store.getWorkItem(id)).toMatchObject({ assignee, humanAssignee: person ?? (assignee === OP ? OP : null) });
  return id;
}

/** An agent's tool call as alice: a real session and the capability the gateway minted for it, as an engine passes them. */
async function agentTool(name: string, args: Record<string, unknown>) {
  const { buildWorkItemTools } = await import("../../mcp/work-item-tools.js");
  const { buildDelegationTools } = await import("../../mcp/delegation-tools.js");
  const { createSession } = await import("../../sessions/registry.js");
  const { ensureSessionCapability } = await import("../../mcp/identity.js");
  const session = createSession({ engine: "claude", source: "web", sourceRef: "agent", employee: "alice" } as never);
  const tool = [...buildWorkItemTools(), ...buildDelegationTools()].find((candidate) => candidate.name === name)!;
  return tool.handler(args, {
    gatewayUrl: h.baseUrl, token: GATEWAY_TOKEN, callerSessionId: session.id, sessionCapability: ensureSessionCapability(session.id),
  } as never);
}
const agentAssign = (id: string, assignee: string) => agentTool("assign_work_item", { id, assignee });

beforeAll(async () => {
  h = await startBoardHarness({ sessions: true });
  store = await import("../../work-items/store.js");
  // A second agent on alice's team, for a delegation that moves a Todo from one agent to another.
  fs.writeFileSync(path.join(process.env.JINN_HOME!, "org", "ops", "mason.yaml"), "name: mason\ndisplayName: Mason\ndepartment: ops\nrank: employee\nreportsTo: alice\nengine: claude\nmodel: sonnet\npersona: test employee\n");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  peer = await h.join("peer@example.test", "collaborator", "ops", "Pia Peer");
}, 60_000);
afterAll(async () => { await h.close(); });

describe("the person slot clearing the operator out of the agent slot", () => {
  it("clearing the person of a Todo that waits on the operator records assigneeCleared", async () => {
    const id = await inState(OP, null);
    expect((await patch(id, { humanAssignee: null })).body.workItem).toMatchObject({ assignee: null, humanAssignee: null });
    expect(lastPersonEvent(id)).toEqual({ from: OP, to: null, assigneeCleared: true });
  });

  it("naming a person on a Todo that waits on the operator records assigneeCleared", async () => {
    const id = await inState(OP, null);
    expect((await patch(id, { humanAssignee: `user:${collab.userId}` })).body.workItem).toMatchObject({ assignee: null });
    expect(lastPersonEvent(id)).toEqual({ from: OP, to: `user:${collab.userId}`, assigneeCleared: true });
  });

  it("naming another person beside a member's name on a Todo that waits on the operator records assigneeCleared", async () => {
    const id = await inState(OP, `user:${collab.userId}`);
    expect((await patch(id, { humanAssignee: `user:${peer.userId}` })).body.workItem).toMatchObject({ assignee: null });
    expect(lastPersonEvent(id)).toEqual({ from: `user:${collab.userId}`, to: `user:${peer.userId}`, assigneeCleared: true });
  });

  it("clearing a member's name there clears no other slot: the agent slot stays, and the operator reads as the person", async () => {
    const id = await inState(OP, `user:${collab.userId}`);
    expect((await patch(id, { humanAssignee: null })).body.workItem).toMatchObject({ assignee: OP, humanAssignee: OP });
    expect(lastPersonEvent(id)).toEqual({ from: `user:${collab.userId}`, to: OP });
  });

  it("a member's write never clears the agent slot: refused where it would, and it moves only the row where it may", async () => {
    const waiting = await inState(OP, `user:${collab.userId}`);
    expect((await putPerson(collab, waiting, `user:${peer.userId}`)).status).toBe(403);
    expect(store.getWorkItem(waiting)).toMatchObject({ assignee: OP, humanAssignee: `user:${collab.userId}` });
    const held = await inState("alice", `user:${collab.userId}`);
    expect((await putPerson(collab, held, null)).status).toBe(200);
    expect(store.getWorkItem(held)).toMatchObject({ assignee: "alice", humanAssignee: null });
    expect(lastPersonEvent(held)).toEqual({ from: `user:${collab.userId}`, to: null });
  });
});

describe("the agent slot clearing the person", () => {
  it("clearing an @operator assignee with no row clears the operator as the person, and records personCleared", async () => {
    const id = await inState(OP, null);
    expect((await patch(id, { assignee: null })).body.workItem).toMatchObject({ assignee: null, humanAssignee: null });
    expect(lastPersonEvent(id)).toEqual({ from: OP, to: null, personCleared: true, withAgent: true });
  });
});

describe("every other agent-slot write clears no person, by any route", () => {
  const STATES: Array<[string | null, string | null]> = [[null, null], ["alice", null], ["alice", "member"], ["alice", OP], [OP, null], [OP, "member"]];
  const writers: Array<[string, (id: string, assignee: string | null) => Promise<unknown>]> = [
    ["the operator's pen", (id, assignee) => patch(id, { assignee })],
    ["the assign route", (id, assignee) => (assignee === null ? patch(id, { assignee }) : h.operator("POST", `/api/work-items/${id}/assign`, { assignee }))],
    ["an agent's assign tool", (id, assignee) => (assignee === null ? patch(id, { assignee }) : agentAssign(id, assignee))],
  ];

  // Assigning to the operator a Todo with no person makes the operator the person (that is how "needs the operator" is
  // stored and read): it fills an empty slot, clears nothing, and records it. Every other write leaves the person alone.
  it.each(writers)("through %s", async (name, write) => {
    for (const [assignee, person] of STATES) for (const next of [null, OP, "alice"]) {
      if (next === assignee || (assignee === OP && person === null && next === null)) continue; // the one that clears, above
      if (name === "an agent's assign tool" && assignee !== "alice") continue; // an agent reassigns only a Todo it holds
      const id = await inState(assignee, person === "member" ? `user:${collab.userId}` : person);
      const before = { person: store.getWorkItem(id)!.humanAssignee, events: personEvents(id).length };
      await write(id, next);
      const after = store.getWorkItem(id)!;
      const fills = before.person === null && next === OP;
      const expected = fills ? [OP, before.events + 1] : [before.person, before.events];
      expect([assignee, person, next, after.humanAssignee, personEvents(id).length]).toEqual([assignee, person, next, ...expected]);
      if (fills) expect(lastPersonEvent(id)).toEqual({ from: null, to: OP, withAgent: true });
    }
  });
});

describe("a delegation never changes the person: the route delegate_task calls, and the tool itself", () => {
  const person = (id: string) => ({ person: store.getWorkItem(id)!.humanAssignee, events: personEvents(id).length });

  it("through POST /api/delegations, from every state, to another agent", async () => {
    for (const [assignee, who, to] of [[OP, null, "alice"], [OP, "member", "alice"], [null, "member", "alice"], ["alice", "member", "mason"], ["alice", OP, "mason"]] as const) {
      const id = await inState(assignee, who === "member" ? `user:${collab.userId}` : who);
      const before = person(id);
      const reply = await h.operator("POST", "/api/delegations", { workItemId: id, employee: to, task: "Take this on" });
      expect([assignee, who, reply.status, store.getWorkItem(id)!.assignee, person(id)]).toEqual([assignee, who, 201, to, before]);
    }
  });

  it("through an agent's delegate_task tool on a Todo it holds", async () => {
    for (const who of ["member", OP] as const) {
      const id = await inState("alice", who === "member" ? `user:${collab.userId}` : who);
      const before = person(id);
      await agentTool("delegate_task", { workItemId: id, employee: "mason", task: "Take this on" });
      expect([who, store.getWorkItem(id)!.assignee, person(id)]).toEqual([who, "mason", before]);
    }
  });
});

describe("removing a user", () => {
  it("tells every Todo that named them, with the person as read afterwards, on the operator's and a member's timeline", async () => {
    const doomed = await h.join("doomed@example.test", "collaborator", "ops", "Dom Doomed");
    const held = await inState("alice", `user:${doomed.userId}`);
    const waiting = await inState(OP, `user:${doomed.userId}`);
    const versions = [store.getWorkItem(held)!.version, store.getWorkItem(waiting)!.version];
    h.broadcasts.length = 0;

    expect((await h.operator("DELETE", `/api/people/${doomed.userId}`)).status).toBe(200);

    expect(lastPersonEvent(held)).toEqual({ from: `user:${doomed.userId}`, to: null, reason: "person_removed" });
    expect(lastPersonEvent(waiting)).toEqual({ from: `user:${doomed.userId}`, to: OP, reason: "person_removed" });
    expect([store.getWorkItem(held)!.version, store.getWorkItem(waiting)!.version]).toEqual(versions.map((v) => v + 1));
    expect(store.getWorkItem(held)).toMatchObject({ assignee: "alice", humanAssignee: null });
    const refreshed = h.broadcasts.filter((b) => b.event === "company:changed" && b.payload.entity === "todo").map((b) => b.payload.id);
    expect(refreshed).toEqual(expect.arrayContaining([held, waiting]));
    const timeline = (await h.as(collab, "GET", `/api/member/todos/${held}`)).body.events.filter((event: any) => event.kind === "person_changed");
    expect(timeline.at(-1)?.detail).toMatchObject({ to: null, reason: "person_removed" });
  });
});
