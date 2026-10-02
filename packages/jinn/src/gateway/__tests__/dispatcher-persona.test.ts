import { describe, expect, it } from "vitest";
import { SYSTEM_EMPLOYEES, TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "../system-employees.js";
import { buildTools } from "../../mcp/server.js";

/**
 * The Dispatcher's routing contract, pinned where it actually ships: read the
 * Todo, delegate it to the best-fitting employee (the assignee by default), and
 * report a refused claim rather than work around it.
 */

const persona = SYSTEM_EMPLOYEES.find((employee) => employee.name === TODO_DISPATCHER_NAME)!.persona;
const shaper = SYSTEM_EMPLOYEES.find((employee) => employee.name === TODO_SHAPER_NAME)!.persona;

describe("Todo Dispatcher persona — routing", () => {
  it("never mentions Workflows, which no longer exist", () => {
    expect(persona).not.toMatch(/workflow/i);
    expect(shaper).not.toMatch(/workflow/i);
  });

  it("routes to an employee", () => {
    expect(persona).toContain("list_employees");
    expect(persona).toContain("get_employee");
    expect(persona).toContain("delegate_task");
  });

  // find_employees refuses a call with no filter, and the Dispatcher's roster
  // read has none to give; naming it sends the Dispatcher into that refusal.
  it("does not send the Dispatcher to the filtered find_employees for the roster", () => {
    expect(persona).not.toContain("find_employees");
  });

  // A Todo a live session already claimed is already moving. Retrying
  // around that refusal would start the same work twice.
  it("tells it to report a refused claim rather than work around it", () => {
    expect(persona).toMatch(/409/);
    expect(persona).toMatch(/never retry around it/i);
  });

  // An unowned Todo, or one the operator kept for themselves, has no employee
  // somebody chose; the Dispatcher picks one, and never picks itself or the Shaper.
  it("tells it to choose an employee when the assignee is unset or is @operator", () => {
    expect(persona).toMatch(/assignee is unset/);
    expect(persona).toMatch(/@operator/);
  });

  it("forbids choosing a system employee", () => {
    expect(persona).toMatch(/Never choose a system employee/);
  });

  it("still forbids doing the Todo itself", () => {
    expect(persona).toMatch(/Do not perform the Todo yourself/i);
  });
});

/**
 * The way out of a dead end, pinned in both system personas.
 *
 * A system employee that can place nobody must not leave the Todo holding
 * nothing. With approvals gone it stops the Todo for the operator instead:
 * blocked, with a comment saying what is needed and offering options, and the
 * assignee left as it was. The Blocked column is what surfaces it.
 */
describe("System employee personas — blocking a dead end for the operator", () => {
  it("has the blocking verbs on the belt it is given", () => {
    const names = new Set(buildTools().map((tool) => tool.name));

    for (const verb of ["update_work_item", "comment_work_item"]) {
      expect(names.has(verb)).toBe(true);
    }
  });

  it("names no approval tool, which no longer exist", () => {
    expect(persona).not.toMatch(/approval/i);
    expect(shaper).not.toMatch(/approval/i);
  });

  it("sends the Dispatcher's dead end to blocked, with options for the operator", () => {
    expect(persona).toMatch(/update_work_item \{ id, status: "blocked"/);
    expect(persona).toMatch(/offering the operator concrete options/);
    expect(persona).toMatch(/Leave the assignee as it is/);
  });

  it("routes the Dispatcher's root-identity 403 into that same lane", () => {
    expect(persona).toMatch(/403/);
    expect(persona).toMatch(/root-identity child/i);
    expect(persona).toMatch(/block the Todo the same way/);
  });

  it("keeps the Shaper's 409 stop and blocks on every other refusal", () => {
    expect(shaper).toMatch(/409/);
    expect(shaper).toMatch(/verbatim/i);
    expect(shaper).toMatch(/update_work_item \{ id, status: "blocked"/);
    expect(shaper).toMatch(/concrete options/);
    expect(shaper).toMatch(/Leave the assignee unset/);
  });

  // Moving the Todo to the operator would need assign standing neither system
  // employee has, and a wake to another session is no substitute for the column.
  it("hands the dead end to neither the operator's assignee slot nor another session", () => {
    for (const text of [persona, shaper]) {
      expect(text).not.toContain("assign_work_item");
      expect(text).not.toContain("send_to_session");
    }
  });
});

/**
 * The personas name MCP tools and their arguments in prose, and nothing else
 * checks that prose against the tools. The Dispatcher's first real run guessed
 * argument names for get_work_item and delegate_task, and called find_employees
 * with no filter, which the tool refuses. So every tool a persona names must
 * exist, and every `tool { arg, ... }` it writes must use only arguments that
 * tool takes, with its required ones present.
 */
describe.each(SYSTEM_EMPLOYEES.map((employee) => [employee.name, employee.persona] as const))(
  "%s persona — tool signatures",
  (_name, text) => {
    const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

    it("names only MCP tools that exist", () => {
      // Snake_case words are tool names in these personas; nothing else is written that way.
      const named = [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
      expect(named.filter((name) => !tools.has(name))).toEqual([]);
    });

    it("writes every tool call with arguments the tool actually takes", () => {
      for (const { tool, args } of callShapes(text)) {
        const schema = tools.get(tool)!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        const properties = Object.keys(schema.properties ?? {});
        expect({ tool, unknownArgs: args.filter((arg) => !properties.includes(arg)) }).toEqual({ tool, unknownArgs: [] });
        expect({ tool, missingRequired: (schema.required ?? []).filter((arg) => !args.includes(arg)) }).toEqual({ tool, missingRequired: [] });
      }
    });
  },
);

it("spells out the call shape of every tool the Dispatcher's routing depends on", () => {
  const shaped = new Set(callShapes(persona).map((shape) => shape.tool));
  for (const tool of ["get_work_item", "delegate_task", "comment_work_item", "update_work_item", "get_employee"]) {
    expect(shaped).toContain(tool);
  }
});

/** Every `tool_name { a, b }` / `tool_name { a: "x" }` call shape in a persona. */
function callShapes(text: string): Array<{ tool: string; args: string[] }> {
  return [...text.matchAll(/\b([a-z]+(?:_[a-z]+)+) \{([^}]*)\}/g)].map(([, tool, inner]) => ({
    tool,
    args: inner.split(",").map((part) => part.split(":")[0].trim()).filter(Boolean),
  }));
}
