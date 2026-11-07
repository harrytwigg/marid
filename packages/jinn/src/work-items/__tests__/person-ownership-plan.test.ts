import { describe, expect, it } from "vitest";
import { personChangedDetail, planOwnership } from "../person-write.js";

/* Where the person and the agent land for an edit of either: the operator as the person is stored the way "needs the
 * operator" always was, so nothing that reads `assignee` changes meaning. */

const OP = "@operator";
const USER = "user:usr_0123456789ab";
const OTHER = "user:usr_ba9876543210";

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
  { name: "assigning to the operator never changes a person that is a user: the row stays beside the operator assignee", from: { assignee: "mason", person: USER }, edit: { assignee: OP }, to: { assignee: OP, person: USER } },
  { name: "assigning to the operator over an @operator row drops that now-redundant row", from: { assignee: "mason", person: OP }, edit: { assignee: OP }, to: { assignee: OP, person: null } },
  { name: "naming the operator as the person over a user's row, with the Todo already on the operator, drops the row", from: { assignee: OP, person: USER }, edit: { humanAssignee: OP }, to: { assignee: OP, person: null } },
  { name: "clearing the person while a user's row sits beside the operator assignee leaves the Todo on the operator", from: { assignee: OP, person: USER }, edit: { humanAssignee: null }, to: { assignee: OP, person: null } },
  { name: "naming another user while a user's row sits beside the operator assignee hands it on: the operator assignee clears", from: { assignee: OP, person: USER }, edit: { humanAssignee: OTHER }, to: { assignee: null, person: OTHER } },
  { name: "clearing the agent leaves a user as the person", from: { assignee: "mason", person: USER }, edit: { assignee: null }, to: { assignee: null, person: USER } },
  { name: "changing the agent leaves the person", from: { assignee: "mason", person: USER }, edit: { assignee: "alice" }, to: { assignee: "alice", person: USER } },
  { name: "an edit that changes nothing changes nothing", from: { assignee: "mason", person: OP }, edit: { assignee: "mason", humanAssignee: OP }, to: { assignee: "mason", person: OP } },
];

describe("planOwnership", () => {
  it.each(CASES)("$name", ({ from, edit, to }) => {
    const plan = planOwnership({ assignee: from.assignee }, from.person, edit);
    expect({ assignee: plan.assignee, person: plan.person }).toEqual(to);
  });

  it("never leaves an @operator row beside an @operator assignee, from any start and any single edit", () => {
    const agents = [null, OP, "mason"];
    const people = [null, OP, USER];
    const edits: Array<Case["edit"]> = [{ assignee: null }, { assignee: OP }, { assignee: "alice" }, { humanAssignee: null }, { humanAssignee: OP }, { humanAssignee: USER }];
    for (const assignee of agents) for (const person of people) {
      if (assignee === OP && person === OP) continue; // not a state the writers can reach
      for (const edit of edits) {
        const plan = planOwnership({ assignee }, person, edit);
        expect([assignee, person, edit, plan.assignee === OP && plan.person === OP]).toEqual([assignee, person, edit, false]);
      }
    }
  });

  it("reads the person before and after as the Todo does: the row, else the operator when the assignee is", () => {
    expect(planOwnership({ assignee: OP }, null, { humanAssignee: USER })).toMatchObject({ from: OP, to: USER, assigneeMovedByPerson: true });
    expect(planOwnership({ assignee: "mason" }, OP, { assignee: null })).toMatchObject({ from: OP, to: OP, assigneeMovedByPerson: false });
    expect(planOwnership({ assignee: OP }, USER, { humanAssignee: OTHER })).toMatchObject({ assignee: null, from: USER, to: OTHER, assigneeMovedByPerson: true });
    expect(planOwnership({ assignee: OP }, USER, { humanAssignee: null })).toMatchObject({ assignee: OP, from: USER, to: OP, assigneeMovedByPerson: false });
  });

  describe("no edit clears a slot it does not name without saying so", () => {
    const states = [
      { assignee: null, person: null }, { assignee: OP, person: null }, { assignee: "mason", person: null },
      { assignee: null, person: USER }, { assignee: OP, person: USER }, { assignee: "mason", person: USER }, { assignee: "mason", person: OP },
    ];

    it("an agent edit never clears a person silently: it clears one only when the assignee was the operator as the person, and records personCleared", () => {
      for (const state of states) for (const assignee of [null, OP, "alice", "mason"]) {
        if (assignee === state.assignee) continue;
        const plan = planOwnership({ assignee: state.assignee }, state.person, { assignee });
        const operatorAsPersonCleared = state.assignee === OP && state.person === null && assignee === null;
        // Assigning to the operator with no person makes the operator read as the person: it fills the slot, clearing nothing.
        const operatorFillsEmpty = plan.from === null && plan.to === OP && assignee === OP;
        expect([state, assignee, plan.to === plan.from || operatorFillsEmpty]).toEqual([state, assignee, !operatorAsPersonCleared]);
        if (operatorAsPersonCleared) expect(personChangedDetail(plan)).toEqual({ from: OP, to: null, personCleared: true });
      }
    });

    it("a person edit that moves the agent slot either names the operator over an empty slot or records assigneeCleared", () => {
      for (const state of states) for (const humanAssignee of [null, OP, USER, OTHER]) {
        const plan = planOwnership({ assignee: state.assignee }, state.person, { humanAssignee });
        if (plan.assignee === state.assignee) continue;
        const namedOperator = state.assignee === null && humanAssignee === OP && plan.assignee === OP;
        const cleared = plan.assignee === null && personChangedDetail(plan).assigneeCleared === true;
        expect([state, humanAssignee, namedOperator || cleared]).toEqual([state, humanAssignee, true]);
      }
    });

    it("records assigneeCleared only when the person slot cleared the agent slot", () => {
      expect(personChangedDetail(planOwnership({ assignee: OP }, null, { humanAssignee: null }))).toEqual({ from: OP, to: null, assigneeCleared: true });
      expect(personChangedDetail(planOwnership({ assignee: OP }, null, { humanAssignee: USER }))).toEqual({ from: OP, to: USER, assigneeCleared: true });
      expect(personChangedDetail(planOwnership({ assignee: OP }, USER, { humanAssignee: OTHER }))).toEqual({ from: USER, to: OTHER, assigneeCleared: true });
      expect(personChangedDetail(planOwnership({ assignee: OP }, USER, { humanAssignee: null }))).toEqual({ from: USER, to: OP });
      expect(personChangedDetail(planOwnership({ assignee: "mason" }, USER, { humanAssignee: null }))).toEqual({ from: USER, to: null });
    });
  });
});
