import { describe, expect, it } from "vitest"
import { personLane } from "../task-page/person-route"

/* Which write a person choice goes through: the same one assign-to-the-operator or unassign always used where the choice leaves
 * the same stored state, the person write everywhere the person differs from the assignee. */

describe("personLane", () => {
  it.each([
    ["yourself, nobody holding either slot", {}, "@operator", "assign-operator"],
    ["yourself, assignee null and no person", { assignee: null, humanAssignee: null }, "@operator", "assign-operator"],
    ["yourself with an agent held", { assignee: "mason", humanAssignee: null }, "@operator", "person"],
    ["yourself replacing a user's row", { assignee: null, humanAssignee: "user:ada1" }, "@operator", "person"],
    ["yourself replacing a user's row beside the operator's wait", { assignee: "@operator", humanAssignee: "user:ada1" }, "@operator", "person"],
    ["a user, nobody holding either slot", {}, "user:ada1", "person"],
    ["clearing the operator who holds the Todo by storage", { assignee: "@operator", humanAssignee: "@operator" }, null, "unassign"],
    ["clearing a user", { assignee: null, humanAssignee: "user:ada1" }, null, "person"],
    ["clearing the operator beside an agent", { assignee: "mason", humanAssignee: "@operator" }, null, "person"],
    ["clearing a user beside the operator's wait", { assignee: "@operator", humanAssignee: "user:ada1" }, null, "person"],
  ] as const)("%s", (_name, item, person, lane) => {
    expect(personLane(item, person)).toBe(lane)
  })
})
