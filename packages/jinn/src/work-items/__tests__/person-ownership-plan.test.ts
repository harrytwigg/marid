import { describe, expect, it } from "vitest";
import { planOwnership } from "../person-write.js";

/* Where the person and the agent land for an edit of either: the operator as the person is stored the way "needs the
 * operator" always was, so nothing that reads `assignee` changes meaning. */

const OP = "@operator";
const USER = "user:usr_0123456789ab";

type Case = { name: string; from: { assignee: string | null; person: string | null }; edit: { assignee?: string | null; humanAssignee?: string | null }; to: { assignee: string | null; person: string | null } };

const CASES: Case[] = [
  { name: "the operator as the person with no agent is the assignee, with no row", from: { assignee: null, person: null }, edit: { humanAssignee: OP }, to: { assignee: OP, person: null } },
  { name: "the operator as the person beside an agent is a row, and the agent keeps the Todo", from: { assignee: "mason", person: null }, edit: { humanAssignee: OP }, to: { assignee: "mason", person: OP } },
  { name: "setting an agent over @operator keeps the operator as the person", from: { assignee: OP, person: null }, edit: { assignee: "mason" }, to: { assignee: "mason", person: OP } },
  { name: "clearing the agent while the row is the operator hands the Todo back to the operator", from: { assignee: "mason", person: OP }, edit: { assignee: null }, to: { assignee: OP, person: null } },
  { name: "clearing the person while the assignee is @operator clears the assignee", from: { assignee: OP, person: null }, edit: { humanAssignee: null }, to: { assignee: null, person: null } },
  { name: "clearing the person when the row is the operator beside an agent drops only the row", from: { assignee: "mason", person: OP }, edit: { humanAssignee: null }, to: { assignee: "mason", person: null } },
  { name: "naming another person while the assignee is @operator clears the assignee: it no longer waits on the operator", from: { assignee: OP, person: null }, edit: { humanAssignee: USER }, to: { assignee: null, person: USER } },
  { name: "naming a person leaves the agent alone", from: { assignee: "mason", person: null }, edit: { humanAssignee: USER }, to: { assignee: "mason", person: USER } },
  { name: "assigning to the operator drops a row that would shadow it", from: { assignee: "mason", person: USER }, edit: { assignee: OP }, to: { assignee: OP, person: null } },
  { name: "clearing the agent leaves a user as the person", from: { assignee: "mason", person: USER }, edit: { assignee: null }, to: { assignee: null, person: USER } },
  { name: "changing the agent leaves the person", from: { assignee: "mason", person: USER }, edit: { assignee: "alice" }, to: { assignee: "alice", person: USER } },
  { name: "an edit that changes nothing changes nothing", from: { assignee: "mason", person: OP }, edit: { assignee: "mason", humanAssignee: OP }, to: { assignee: "mason", person: OP } },
];

describe("planOwnership", () => {
  it.each(CASES)("$name", ({ from, edit, to }) => {
    const plan = planOwnership({ assignee: from.assignee }, from.person, edit);
    expect({ assignee: plan.assignee, person: plan.person }).toEqual(to);
  });

  it("never leaves an @operator assignee with a row, from any start and any single edit", () => {
    const agents = [null, OP, "mason"];
    const people = [null, OP, USER];
    const edits: Array<Case["edit"]> = [{ assignee: null }, { assignee: OP }, { assignee: "alice" }, { humanAssignee: null }, { humanAssignee: OP }, { humanAssignee: USER }];
    for (const assignee of agents) for (const person of people) {
      if (assignee === OP && person !== null) continue; // not a state the writers can reach
      for (const edit of edits) {
        const plan = planOwnership({ assignee }, person, edit);
        expect([assignee, person, edit, plan.assignee === OP && plan.person !== null]).toEqual([assignee, person, edit, false]);
      }
    }
  });

  it("reads the person before and after as the Todo does: the row, else the operator when the assignee is", () => {
    expect(planOwnership({ assignee: OP }, null, { humanAssignee: USER })).toMatchObject({ from: OP, to: USER, assigneeMovedByPerson: true });
    expect(planOwnership({ assignee: "mason" }, OP, { assignee: null })).toMatchObject({ from: OP, to: OP, assigneeMovedByPerson: false });
  });
});
