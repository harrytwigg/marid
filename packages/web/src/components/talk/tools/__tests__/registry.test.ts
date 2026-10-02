import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { clearToolTimings, lastToolTiming, TOOL_BUDGET_MS } from "../budget"
import { clearTalkNavigator, registerTalkNavigator } from "../router-handle"
import { executeToolCall, findTool, TALK_TOOLS, toolDefinitions } from "../registry"

vi.mock("@/lib/api", () => ({ api: {} }))

const visited: string[] = []

/** One drained paint, in the two-frame shape `afterNextPaint` records timings
 *  in. rAF runs callbacks in registration order, so a paint callback scheduled
 *  before this one has always fired by the time it resolves. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))
  })
}

beforeEach(() => {
  visited.length = 0
  clearToolTimings()
  registerTalkNavigator((path) => {
    visited.push(path)
    return Promise.resolve()
  })
  queryClient.setQueryData(queryKeys.onboarding, { todoPrefix: "ABC" })
})

afterEach(() => {
  clearTalkNavigator()
  queryClient.clear()
})

describe("the registered set", () => {
  it("has no duplicate names", () => {
    const names = TALK_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("covers all six domains with a navigate tool and the four read shapes", () => {
    const names = new Set(TALK_TOOLS.map((tool) => tool.name))
    for (const name of [
      "open_todos", "open_todo", "open_chats", "open_org", "open_cron",
      "read_todo", "read_session",
    ]) {
      expect(names.has(name), name).toBe(true)
    }
  })

  it("emits definitions a realtime provider can take unchanged", () => {
    // Structurally `RealtimeTool` from packages/jinn/src/shared/types.ts: the web
    // package cannot import it, so the shape is pinned here instead.
    for (const definition of toolDefinitions()) {
      expect(Object.keys(definition).sort()).toEqual(["description", "name", "parameters"])
      expect(typeof definition.name).toBe("string")
      expect(definition.description.length).toBeGreaterThan(10)
      expect(definition.parameters.type).toBe("object")
      expect(definition.parameters.additionalProperties).toBe(false)
      for (const property of Object.values(definition.parameters.properties)) {
        expect(property.description.length).toBeGreaterThan(0)
      }
    }
  })

  it("declares every required argument as a real property", () => {
    for (const tool of TALK_TOOLS) {
      for (const key of tool.parameters.required ?? []) {
        expect(tool.parameters.properties[key], `${tool.name}.${key}`).toBeDefined()
      }
    }
  })
})

describe("the two done-when calls", () => {
  it('lands "executing todos I started" on the home board, taking the legacy "my" alias', async () => {
    const result = await executeToolCall("open_todos", '{"board":"my","status":"executing"}')
    expect(result).toEqual({ ok: true, data: { path: "/todos/b/home?status=executing" } })
    expect(visited).toEqual(["/todos/b/home?status=executing"])
  })

  it('opens "Todo 59" from a bare number or a prefixed id', async () => {
    await executeToolCall("open_todo", '{"id":"59"}')
    await executeToolCall("open_todo", '{"id":"ABC-59"}')
    expect(visited).toEqual(["/todos/ABC-59", "/todos/ABC-59"])
  })

  it("navigates before the executor's promise settles", async () => {
    // This is what lets the transport fire on partial intent rather than waiting
    // for the model to finish speaking.
    const settling = executeToolCall("open_todos", '{"status":"executing"}')
    expect(visited).toEqual(["/todos/b/home?status=executing"])
    await settling
  })

  it("issues the route change synchronously but settles on its arrival", async () => {
    // A navigator whose commit is delayed. The request must go out before
    // anything is awaited (partial intent), and the timing must not stop until
    // the destination has actually landed — a clock that stopped at the request
    // would report a number the operator never experienced.
    let land = () => {}
    registerTalkNavigator((path) => {
      visited.push(path)
      return new Promise<void>((resolve) => { land = resolve })
    })
    // An earlier case's paint callback may still be in flight, so drain it
    // before clearing. The timings read below then belong unambiguously to
    // this call.
    await nextPaint()
    clearToolTimings()

    const settling = executeToolCall("open_todos", '{"status":"executing"}')
    expect(visited).toEqual(["/todos/b/home?status=executing"])

    let settled = false
    void settling.then(() => { settled = true })
    // Real wall-clock time, not a paint wait: the clock has to accumulate
    // something for the lower bound below to mean anything, and that it is
    // still unsettled after it is the point of the case.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(lastToolTiming()).toBeUndefined()

    land()
    expect(await settling).toEqual({ ok: true, data: { path: "/todos/b/home?status=executing" } })
    await vi.waitFor(() => { expect(lastToolTiming()?.ms).toBeGreaterThanOrEqual(25) })
  })

  it("records both calls inside the budget", async () => {
    for (const [name, args] of [["open_todos", '{"status":"executing"}'], ["open_todo", '{"id":"59"}']] as const) {
      clearToolTimings()
      await executeToolCall(name, args)
      await vi.waitFor(() => { expect(lastToolTiming()?.tool).toBe(name) })
      const timing = lastToolTiming()
      expect(timing?.tool).toBe(name)
      expect(timing?.ms).toBeLessThan(TOOL_BUDGET_MS)
    }
  })

  it("reports honestly when the app has not mounted", async () => {
    clearTalkNavigator()
    const result = await executeToolCall("open_todos", "{}")
    expect(result).toEqual({ ok: false, error: expect.stringContaining("not mounted") })
  })

  it("asks for a prefix rather than guessing one", async () => {
    queryClient.setQueryData(queryKeys.onboarding, { todoPrefix: null })
    const result = await executeToolCall("open_todo", '{"id":"59"}')
    expect(result.ok).toBe(false)
    expect(visited).toEqual([])
  })
})

describe("bad input fails honestly, never fatally", () => {
  it("names the unknown tool and lists what does exist", async () => {
    const result = await executeToolCall("open_the_pod_bay_doors", "{}")
    expect(result).toEqual({ ok: false, error: expect.stringContaining("open_todos") })
  })

  it("reports malformed JSON arguments", async () => {
    const result = await executeToolCall("open_todo", "{id: 59")
    expect(result).toEqual({ ok: false, error: expect.stringContaining("valid JSON") })
  })

  it("reports schema-violating arguments", async () => {
    const result = await executeToolCall("open_todos", '{"status":"almost-done"}')
    expect(result).toEqual({ ok: false, error: expect.stringContaining("must be one of") })
    expect(visited).toEqual([])
  })

  it("turns a throwing executor into a result instead of taking the session down", async () => {
    const tool = findTool("focus_element")!
    const original = tool.execute
    tool.execute = () => { throw new Error("boom") }
    try {
      await expect(executeToolCall("focus_element", '{"target":"x"}')).resolves.toEqual({
        ok: false,
        error: expect.stringContaining("boom"),
      })
    } finally {
      tool.execute = original
    }
  })
})

describe("the catch-all", () => {
  it("refuses out loud when it has nowhere to record the ask", async () => {
    expect(findTool("jinn_action")).toBeDefined()
    const result = await executeToolCall("jinn_action", '{"intent":"comment on Todo 59"}')
    expect(result.ok).toBe(false)
    expect(result).toEqual({ ok: false, error: expect.stringContaining("has no tool for") })
  })
})
