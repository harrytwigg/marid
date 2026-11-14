import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/* `humanAssignee` is the person-slot filter on the list. It ANDs with `assignee` (the agent slot), and a member can only
 * filter by people they may read as people: the operator, none, or someone who shares a board with them. */

let h: BoardHarness;
let casey: Member;
let pia: Member;
let stranger: Member;
let store: typeof import("../../work-items/store.js");

const opsTodo = (title: string, extra: Record<string, unknown> = {}) => store.createWorkItem({ title, department: "ops", ...extra });
// Written straight to the person table: the pen refuses a person who is not on the Todo's board, and the filter must still
// not confirm such a person to a member.
const setPerson = (id: string, person: string) =>
  h.db.prepare("INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, 'operator', 't')").run(id, person);
const titles = (body: any) => body.workItems.map((row: any) => row.title).sort();

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  casey = await h.join("casey@example.test", "collaborator", "ops", "Casey Collab");
  pia = await h.join("pia@example.test", "collaborator", "ops", "Pia Peer");
  stranger = await h.join("stranger@example.test", "collaborator", "design", "Sid Stranger");
  const caseyAndAgent = opsTodo("casey and agent", { assignee: "some-employee" });
  const caseyOnly = opsTodo("casey only");
  const piaAndAgent = opsTodo("pia and agent", { assignee: "some-employee" });
  const strangerOnly = opsTodo("stranger only");
  opsTodo("agent only", { assignee: "some-employee" });
  opsTodo("nobody");
  setPerson(caseyAndAgent.id, `user:${casey.userId}`);
  setPerson(caseyOnly.id, `user:${casey.userId}`);
  setPerson(piaAndAgent.id, `user:${pia.userId}`);
  setPerson(strangerOnly.id, `user:${stranger.userId}`);
}, 60_000);
afterAll(async () => { await h.close(); });

const enc = encodeURIComponent;

describe("the operator's list", () => {
  it("filters by person, by agent, and by both at once", async () => {
    const byPerson = await h.operator("GET", `/api/work-items?department=ops&humanAssignee=${enc(`user:${casey.userId}`)}&limit=100`);
    expect(titles(byPerson.body)).toEqual(["casey and agent", "casey only"]);
    const byAgent = await h.operator("GET", "/api/work-items?department=ops&assignee=some-employee&limit=100");
    expect(titles(byAgent.body)).toEqual(["agent only", "casey and agent", "pia and agent"]);
    const both = await h.operator("GET", `/api/work-items?department=ops&humanAssignee=${enc(`user:${casey.userId}`)}&assignee=some-employee&limit=100`);
    expect(titles(both.body)).toEqual(["casey and agent"]);
    expect(both.body.total).toBe(1);
  });

  it("@unassigned on either slot matches the Todos with none in it", async () => {
    const noPerson = await h.operator("GET", "/api/work-items?department=ops&humanAssignee=@unassigned&limit=100");
    expect(titles(noPerson.body)).toEqual(["agent only", "nobody"]);
    const noAgent = await h.operator("GET", `/api/work-items?department=ops&humanAssignee=${enc(`user:${casey.userId}`)}&assignee=@unassigned&limit=100`);
    expect(titles(noAgent.body)).toEqual(["casey only"]);
  });

  it("search takes it as a filter too", async () => {
    const found = await h.operator("GET", `/api/search/work-items?humanAssignee=${enc(`user:${pia.userId}`)}&limit=20`);
    expect(found.status).toBe(200);
    expect(titles(found.body)).toEqual(["pia and agent"]);
  });
});

describe("a member's board list", () => {
  it("takes the person filter for someone they share a board with, and for themself", async () => {
    const peer = await h.as(casey, "GET", `/api/member/boards/ops/todos?humanAssignee=${enc(`user:${pia.userId}`)}&limit=100`);
    expect(peer.status).toBe(200);
    expect(titles(peer.body)).toEqual(["pia and agent"]);
    const self = await h.as(casey, "GET", `/api/member/boards/ops/todos?humanAssignee=${enc(`user:${casey.userId}`)}&assignee=some-employee&limit=100`);
    expect(titles(self.body)).toEqual(["casey and agent"]);
  });

  it("answers no Todos, as if nobody held any, for a person off their boards, so the filter cannot confirm who holds what", async () => {
    const hidden = await h.as(casey, "GET", `/api/member/boards/ops/todos?humanAssignee=${enc(`user:${stranger.userId}`)}&limit=100`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.workItems).toEqual([]);
    expect(hidden.body.total).toBe(0);
    const unknown = await h.as(casey, "GET", `/api/member/boards/ops/todos?humanAssignee=${enc("user:no-such-user")}&limit=100`);
    expect(unknown.body.workItems).toEqual([]);
    // The same Todo is there to the operator, so it is the filter that hides it and nothing else.
    const operator = await h.operator("GET", `/api/work-items?department=ops&humanAssignee=${enc(`user:${stranger.userId}`)}&limit=100`);
    expect(titles(operator.body)).toEqual(["stranger only"]);
  });

  it("judges each name in a list, so a name they may read cannot carry one they may not", async () => {
    const mixed = await h.as(casey, "GET", `/api/member/boards/ops/todos?humanAssignee=${enc(`user:${casey.userId},user:${stranger.userId}`)}&limit=100`);
    expect(titles(mixed.body)).not.toContain("stranger only");
    const padded = await h.as(casey, "GET", `/api/member/boards/ops/todos?humanAssignee=${enc(`@unassigned, user:${stranger.userId}`)}&limit=100`);
    expect(titles(padded.body)).toEqual(["agent only", "nobody"]);
  });

  it("@unassigned works for a member, and the filter never widens what they can read", async () => {
    const none = await h.as(casey, "GET", "/api/member/boards/ops/todos?humanAssignee=@unassigned&limit=100");
    expect(titles(none.body)).toEqual(["agent only", "nobody"]);
    // Another board's Todos stay out of reach whatever the person filter names.
    store.createWorkItem({ title: "unreachable", department: "design" });
    const all = await h.as(casey, "GET", "/api/member/boards/ops/todos?humanAssignee=@unassigned&limit=100");
    expect(titles(all.body)).not.toContain("unreachable");
  });
});
