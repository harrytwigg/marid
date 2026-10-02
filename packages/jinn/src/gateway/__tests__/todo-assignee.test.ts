import { describe, expect, it } from "vitest";
import type { Employee } from "../../shared/types.js";
import { checkAssignee } from "../todo-assignee.js";

const employee = (name: string, extra: Partial<Employee> = {}) =>
  ({ name, displayName: name, department: "platform", rank: "employee", engine: "codex", model: "m", persona: "p", ...extra }) as Employee;
const roster = new Map([["platform-worker", employee("platform-worker")], ["todo-dispatcher", employee("todo-dispatcher", { system: true })]]);

describe("checkAssignee — one answer for every surface that sets an assignee", () => {
  it("takes an employee, and the operator where the surface assigns rather than runs", () => {
    expect(checkAssignee(roster, "platform-worker", { operator: true })).toMatchObject({ ok: true, employee: { name: "platform-worker" } });
    expect(checkAssignee(roster, "@operator", { operator: true })).toEqual({ ok: true, employee: undefined });
    expect(checkAssignee(roster, "@operator", { operator: false })).toMatchObject({ ok: false, error: expect.stringMatching(/a person/) });
  });

  it("refuses a system employee and an unknown name, suggesting the nearest employee", () => {
    for (const operator of [true, false]) {
      expect(checkAssignee(roster, "todo-dispatcher", { operator })).toMatchObject({ ok: false, error: expect.stringMatching(/system employee/) });
    }
    expect(checkAssignee(roster, "platform-wroker", { operator: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Did you mean "platform-worker"/) });
  });
});
