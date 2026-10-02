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

  it("still forbids doing the Todo itself", () => {
    expect(persona).toMatch(/Do not perform the Todo yourself/i);
  });
});

/**
 * ICI-1420 — the way out of a dead end, pinned in both system personas.
 *
 * A system employee that can place nobody used to stop at a comment, leaving the
 * Todo holding nothing. It now hands the work up the approval lane and wakes the
 * COO, so the same text has to keep naming verbs that are actually reachable.
 */
describe("System employee personas — handing a Todo up instead of dead-ending", () => {
  it("has the escalation verbs on the belt it is given", () => {
    const names = new Set(buildTools().map((tool) => tool.name));

    for (const verb of ["request_work_item_approval", "list_sessions", "send_to_session"]) {
      expect(names.has(verb)).toBe(true);
    }
  });

  it("sends the Dispatcher up the approval lane rather than stopping at a comment", () => {
    expect(persona).toContain("request_work_item_approval");
    expect(persona).not.toMatch(/explain the missing role in a Todo comment/i);
  });

  it("routes the Dispatcher's root-identity 403 into that same lane", () => {
    expect(persona).toMatch(/403/);
    expect(persona).toMatch(/root-identity child/i);
  });

  // A gate nobody polls is not a hand-off, so the wake ships with it — and it is
  // best-effort, because losing the wake must not lose the Todo.
  it("pairs the Dispatcher's gate with a best-effort wake", () => {
    expect(persona).toContain("send_to_session");
    expect(persona).toMatch(/best-effort/i);
  });

  it("keeps the Shaper's 409 stop and routes every other refusal up", () => {
    expect(shaper).toMatch(/409/);
    expect(shaper).toMatch(/verbatim/i);
    expect(shaper).toContain("request_work_item_approval");
    expect(shaper).toContain("send_to_session");
  });

  // escalate_work_item_approval is the routed approver's lever and 403s the
  // requester, so naming it as the hand-off would send both employees into a
  // guaranteed refusal.
  it("names neither employee's hand-off as the approver's own lever", () => {
    expect(persona).not.toContain("escalate_work_item_approval");
    expect(shaper).not.toContain("escalate_work_item_approval");
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
  for (const tool of ["get_work_item", "delegate_task", "comment_work_item", "request_work_item_approval", "get_employee"]) {
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
