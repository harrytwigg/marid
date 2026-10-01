import { describe, expect, it } from "vitest";
import { SYSTEM_EMPLOYEES, TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "../system-employees.js";
import { buildTools } from "../../mcp/server.js";

/**
 * The Dispatcher's routing contract, pinned where it actually ships.
 *
 * This persona is the whole of the workflow-aware routing feature — there is no
 * backend half to test, because `start_workflow_run` already takes a `todoId`.
 * So what has to be guarded is that the shipped text still tells the Dispatcher
 * to look for a Workflow first, to monitor what it starts, to fall back to an
 * employee, and which way to lean when the two are close.
 */

const persona = SYSTEM_EMPLOYEES.find((employee) => employee.name === TODO_DISPATCHER_NAME)!.persona;
const shaper = SYSTEM_EMPLOYEES.find((employee) => employee.name === TODO_SHAPER_NAME)!.persona;

describe("Todo Dispatcher persona — workflow-aware routing", () => {
  it("has the four workflow verbs it is told to use on the belt it is given", () => {
    const names = new Set(buildTools().map((tool) => tool.name));

    for (const verb of ["list_workflows", "get_workflow", "start_workflow_run", "get_workflow_run"]) {
      expect(names.has(verb)).toBe(true);
    }
  });

  // Binding the run to the Todo is what makes journey step 7 checkable at all:
  // without it, GET /api/workflows/:id/runs has no trigger.todoId to show.
  it("can bind the run it starts to the Todo, with no new backend", () => {
    const start = buildTools().find((tool) => tool.name === "start_workflow_run")!;

    expect(Object.keys(start.inputSchema.properties ?? {})).toContain("todoId");
  });

  it("looks for a Workflow before an employee, and says so in that order", () => {
    expect(persona).toContain("list_workflows");
    expect(persona).toContain("get_workflow");
    expect(persona.indexOf("list_workflows")).toBeLessThan(persona.indexOf("list_employees"));
  });

  it("keeps the employee branch as the fallback", () => {
    expect(persona).toContain("list_employees");
    expect(persona).toContain("get_employee");
    expect(persona).toContain("delegate_task");
  });

  // find_employees refuses a call with no filter; the whole roster is list_employees.
  it("reads the roster with list_employees, not an unfiltered find_employees", () => {
    expect(persona).toContain("list_employees {}");
    expect(persona).not.toContain("find_employees");
  });

  // Dispatch on an assigned Todo is how the operator starts the employee they
  // picked; overriding that choice is allowed, but it is not the default.
  it("makes the existing assignee the default delegate", () => {
    expect(persona).toMatch(/already has an assignee[^.]*: delegating to them is the default/);
  });

  // Fire-and-forget was the specific failure mode this rewrite exists to stop.
  it("tells it to monitor the run it started rather than firing and forgetting", () => {
    expect(persona).toContain("start_workflow_run");
    expect(persona).toContain("get_workflow_run");
    expect(persona).toMatch(/walking away is not dispatching/i);
  });

  it("states the bias, so a close call falls back instead of guessing", () => {
    expect(persona).toMatch(/a wrong Workflow is worse than falling back/i);
  });

  // A Todo a todo-status trigger already claimed is already moving. Retrying
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
  for (const tool of ["get_work_item", "delegate_task", "comment_work_item", "request_work_item_approval", "start_workflow_run", "get_employee"]) {
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
