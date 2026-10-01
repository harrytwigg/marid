import { describe, expect, it } from "vitest"
import { filtersFromSearchParams } from "@/lib/todos"
import {
  chatPath,
  cronPath,
  orgPath,
  resolveTodoId,
  todoPath,
  todosPath,
  workflowPath,
} from "../nav-paths"

describe("todosPath", () => {
  it("resolves \"executing todos I started\" to the home board filtered by status", () => {
    // The done-when for this child: board `home` IS kept + roots only
    // (boardScopeParams), so the whole request is one URL.
    expect(todosPath({ board: "home", status: "executing" })).toBe("/todos/b/home?status=executing")
  })

  it("defaults to the home board", () => {
    expect(todosPath({})).toBe("/todos/b/home")
    expect(todosPath({ status: "executing" })).toBe("/todos/b/home?status=executing")
  })

  it("keeps the default status out of the URL", () => {
    expect(todosPath({ board: "everything", status: "open" })).toBe("/todos/b/everything")
  })

  it("routes a department name to its board", () => {
    expect(todosPath({ board: "platform" })).toBe("/todos/b/platform")
  })

  it("falls back to the home board rather than a dead page for an unusable board", () => {
    expect(todosPath({ board: "  " })).toBe("/todos/b/home")
    expect(todosPath({ board: "../etc" })).toBe("/todos/b/home")
  })

  it("round-trips its filters back through the board's own parser", () => {
    // Guards against drift in lib/todos.ts: whatever the tool writes, the board
    // has to read back as the same filters.
    const path = todosPath({ status: "blocked", assignee: "a-lead", label: "build", due: "overdue", q: "orb" })
    const search = new URLSearchParams(path.slice(path.indexOf("?")))
    expect(filtersFromSearchParams(search)).toEqual({
      status: "blocked",
      assignee: "a-lead",
      label: "build",
      due: "overdue",
      q: "orb",
    })
  })
})

describe("resolveTodoId", () => {
  it("accepts a spoken bare number against the company prefix", () => {
    expect(resolveTodoId("59", "ABC")).toEqual({ id: "ABC-59" })
    expect(resolveTodoId(59, "ABC")).toEqual({ id: "ABC-59" })
  })

  it("accepts an already-prefixed id, in any case or spacing speech produces", () => {
    expect(resolveTodoId("ABC-59", "ZZZ")).toEqual({ id: "ABC-59" })
    expect(resolveTodoId("abc-59", "ZZZ")).toEqual({ id: "ABC-59" })
    expect(resolveTodoId(" ABC 59 ", "ZZZ")).toEqual({ id: "ABC-59" })
  })

  it("says how to phrase it when there is no prefix to fall back on", () => {
    const resolved = resolveTodoId("59", null)
    expect(resolved).not.toHaveProperty("id")
    expect("error" in resolved && resolved.error).toContain("prefix")
  })

  it("rejects something that is not a Todo id at all", () => {
    const resolved = resolveTodoId("the orb one", "ABC")
    expect("error" in resolved && resolved.error).toContain("ABC-59")
  })

  it("rejects an empty id", () => {
    expect("error" in resolveTodoId("", "ABC")).toBe(true)
  })
})

describe("todoPath", () => {
  it("opens the task page", () => {
    expect(todoPath("ABC-59")).toBe("/todos/ABC-59")
  })
})

describe("the remaining five domains", () => {
  it("opens the workflow list, one workflow, and its runs lens", () => {
    expect(workflowPath({})).toBe("/workflow")
    expect(workflowPath({ id: "jinn-build" })).toBe("/workflow/jinn-build")
    expect(workflowPath({ id: "jinn-build", lens: "runs" })).toBe("/workflow/jinn-build?lens=runs")
    // `editor` is the page's default and stays out of the URL, matching how the
    // page's own lens control writes it.
    expect(workflowPath({ id: "jinn-build", lens: "editor" })).toBe("/workflow/jinn-build")
  })

  it("ignores a lens with no workflow to apply it to", () => {
    expect(workflowPath({ lens: "runs" })).toBe("/workflow")
  })

  it("opens chats and one session", () => {
    expect(chatPath({})).toBe("/")
    expect(chatPath({ sessionId: "abc-123" })).toBe("/?session=abc-123")
  })

  it("opens the org chart and one employee", () => {
    expect(orgPath({})).toBe("/org")
    expect(orgPath({ employee: "a-lead" })).toBe("/org?employee=a-lead")
  })

  it("opens cron, one job, and a filtered lens", () => {
    expect(cronPath({})).toBe("/cron")
    expect(cronPath({ id: "nightly-sweep" })).toBe("/cron/nightly-sweep")
    expect(cronPath({ lens: "week" })).toBe("/cron?lens=week")
    expect(cronPath({ filter: "disabled" })).toBe("/cron?filter=disabled")
    expect(cronPath({ lens: "week", filter: "enabled" })).toBe("/cron?lens=week&filter=enabled")
  })

  it("keeps cron defaults out of the URL and ignores a filter on a job page", () => {
    expect(cronPath({ lens: "jobs", filter: "all" })).toBe("/cron")
    expect(cronPath({ id: "nightly-sweep", filter: "enabled" })).toBe("/cron/nightly-sweep")
  })

  it("escapes an id that would otherwise change the route", () => {
    expect(workflowPath({ id: "a/b" })).toBe("/workflow/a%2Fb")
    expect(cronPath({ id: "a b" })).toBe("/cron/a%20b")
  })
})
