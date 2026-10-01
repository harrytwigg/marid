import { describe, expect, it } from "vitest"
import { filtersFromSearchParams } from "@/lib/todos"
import { describeLocation } from "../page-snapshot"

describe("describing the operator's location", () => {
  it("reads a board with its filters and its search query", () => {
    expect(describeLocation("/todos/b/platform", "?status=executing&assignee=a-lead&q=orb")).toEqual({
      kind: "todos",
      path: "/todos/b/platform",
      params: { board: "platform" },
      filters: { status: "executing", assignee: "a-lead", q: "orb" },
      selection: null,
    })
  })

  it("round-trips its filters back through the parser the board reads the URL with", () => {
    // The snapshot's filters are re-parsed downstream to rebuild the board's
    // cache key, so whatever the URL was padded with has to land on the same
    // filters either way round — otherwise the two sides key apart.
    for (const raw of [
      "?assignee=%20scout%20&department=%20platform%20&label=%20build%20",
      "?q=%20orb%20",
      "?status=all",
      "",
    ]) {
      const snapshot = describeLocation("/todos/b/platform", raw)
      expect(filtersFromSearchParams(new URLSearchParams(snapshot.filters)))
        .toEqual(filtersFromSearchParams(new URLSearchParams(raw)))
    }
  })

  it("keeps the home board's implied status filter, which is what the board shows", () => {
    expect(describeLocation("/todos/b/home", "")).toEqual({
      kind: "todos",
      path: "/todos/b/home",
      params: { board: "home" },
      filters: { status: "open" },
      selection: null,
    })
  })

  it("names the open Todo as the selection, not as a route param", () => {
    expect(describeLocation("/todos/ABC-744", "")).toEqual({
      kind: "todo",
      path: "/todos/ABC-744",
      params: {},
      filters: {},
      selection: { kind: "Todo", id: "ABC-744" },
    })
  })

  it("reads a workflow run as the run it is on, under the workflow that owns it", () => {
    expect(describeLocation("/workflow/nightly-build/runs/run_0f21c7", "")).toEqual({
      kind: "workflow-run",
      path: "/workflow/nightly-build/runs/run_0f21c7",
      params: { workflow: "nightly-build" },
      filters: {},
      selection: { kind: "workflow run", id: "run_0f21c7" },
    })
  })

  it("reads the workflow editor and its runs lens apart", () => {
    expect(describeLocation("/workflow/nightly-build", "")).toMatchObject({
      kind: "workflow",
      filters: {},
      selection: { kind: "workflow", id: "nightly-build" },
    })
    expect(describeLocation("/workflow/nightly-build", "?lens=runs")).toMatchObject({
      kind: "workflow",
      filters: { lens: "runs" },
    })
  })

  it("reads chat's selected session from the query, where chat keeps it", () => {
    expect(describeLocation("/", "?session=sess-4821")).toEqual({
      kind: "chat",
      path: "/",
      params: {},
      filters: {},
      selection: { kind: "chat session", id: "sess-4821" },
    })
  })

  it("reads chat with nothing selected", () => {
    expect(describeLocation("/", "")).toEqual({
      kind: "chat",
      path: "/",
      params: {},
      filters: {},
      selection: null,
    })
  })

  it("degrades an unknown route to its path and nothing invented", () => {
    expect(describeLocation("/somewhere/nobody/added", "?x=1")).toEqual({
      kind: "other",
      path: "/somewhere/nobody/added",
      params: {},
      filters: {},
      selection: null,
    })
  })

  it("degrades a near miss on a real surface too, rather than guessing at it", () => {
    // A path that no declared route matches is an unknown page even when its
    // first segment is one the parser knows: the app renders the plugin splat
    // there, and naming a Todo the operator cannot see is worse than saying
    // nothing about it.
    for (const [pathname, search] of [
      ["/todos/ABC-744/extra", "?x=1"],
      ["/todos/b", ""],
      ["/todos/b/platform/extra", ""],
      ["/workflow/nightly-build/garbage", ""],
      ["/workflow/nightly-build/runs/run_0f21c7/extra", ""],
      ["/experiments", ""],
      ["/experiments/exp-1", ""],
      ["/cron/nightly-sync/history", ""],
      ["/org/a-lead", ""],
    ] as const) {
      expect(describeLocation(pathname, search)).toEqual({
        kind: "other",
        path: pathname,
        params: {},
        filters: {},
        selection: null,
      })
    }
  })

  it("never throws, whatever the location says", () => {
    for (const [pathname, search] of [
      ["", ""],
      ["/", "?session="],
      ["/todos/b/%", ""],
      ["/todos/%E0%A4%A", ""],
      ["/workflow/%/runs/%", "?lens=%"],
      ["/notes/f/%2Fetc%2Fpasswd/n/%", ""],
      ["///", "?&&=="],
    ] as const) {
      expect(() => describeLocation(pathname, search)).not.toThrow()
      expect(describeLocation(pathname, search).path).toBe(pathname)
    }
  })

  it("reads the other surfaces the orb can navigate to", () => {
    expect(describeLocation("/org", "?employee=a-lead")).toMatchObject({
      kind: "org",
      selection: { kind: "employee", id: "a-lead" },
    })
    expect(describeLocation("/cron/nightly-sync", "")).toMatchObject({
      kind: "cron",
      selection: { kind: "cron job", id: "nightly-sync" },
    })
    expect(describeLocation("/cron", "?lens=week&filter=enabled")).toMatchObject({
      kind: "cron",
      filters: { lens: "week", filter: "enabled" },
      selection: null,
    })
    // Folder and open note are carried independently, so the note's own path is
    // the whole knowledge-relative one, not one relative to the folder chip.
    expect(describeLocation("/notes/f/product/n/product/roadmap", "")).toMatchObject({
      kind: "notes",
      params: { folder: "product" },
      selection: { kind: "note", id: "knowledge/product/roadmap.md" },
    })
  })
})
