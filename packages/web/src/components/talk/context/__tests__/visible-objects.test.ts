import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { queryClient } from "@/lib/query-client"
import type { WorkItemStatusWire } from "@/lib/api"
import { filtersFromSearchParams, type TodoFilters } from "@/lib/todos"
import type { BoardId } from "@/routes/todos/board/board-route"
import { boardColumnQueryKey } from "@/routes/todos/board/use-board"
import { describeLocation } from "../page-snapshot"
import { visibleObjects } from "../visible-objects"

const PLATFORM: BoardId = { kind: "department", slug: "platform" }

/** A column exactly as the board's own infinite query leaves it in the cache. */
function seedColumn(
  status: WorkItemStatusWire,
  filters: TodoFilters,
  items: Array<{ id: string; title: string }>,
): void {
  queryClient.setQueryData(boardColumnQueryKey(PLATFORM, status, filters), {
    pages: [{ workItems: items, total: items.length, nextOffset: null }],
  })
}

beforeEach(() => queryClient.clear())
afterEach(() => queryClient.clear())

describe("the objects on the board the operator is looking at", () => {
  it("collects every column of this board, and names a Todo once", () => {
    const filters: TodoFilters = { status: "open" }
    seedColumn("executing", filters, [{ id: "ABC-1", title: "Ship the orb" }])
    seedColumn("in_review", filters, [
      { id: "ABC-1", title: "Ship the orb" },
      { id: "ABC-2", title: "Read the board" },
    ])

    expect(visibleObjects(describeLocation("/todos/b/platform", ""))).toEqual([
      { id: "ABC-1", title: "Ship the orb" },
      { id: "ABC-2", title: "Read the board" },
    ])
  })

  it("leaves a retained filter variant off the screen it is not on", () => {
    // The board keeps its previous filter's columns in the cache, so a snapshot
    // that read the board by prefix would report the Todos of a search the
    // operator has already typed past.
    seedColumn("executing", { status: "open", q: "alpha" }, [{ id: "ABC-ALPHA", title: "Alpha" }])
    seedColumn("executing", { status: "open", q: "beta" }, [{ id: "ABC-BETA", title: "Beta" }])

    expect(visibleObjects(describeLocation("/todos/b/platform", "?q=beta"))).toEqual([
      { id: "ABC-BETA", title: "Beta" },
    ])
  })

  it("finds a column whose Person filter matches more widely than the URL says", () => {
    // "Me" with one owner account asks the list for both of the operator's identities, and keys that.
    const filters: TodoFilters = { status: "open", person: "@operator" }
    queryClient.setQueryData(boardColumnQueryKey(PLATFORM, "executing", filters, "@operator,user:u3"), {
      pages: [{ workItems: [{ id: "ABC-3", title: "Named by account" }], total: 1, nextOffset: null }],
    })
    seedColumn("executing", { status: "open", person: "user:u9" }, [{ id: "ABC-OTHER", title: "Someone else's" }])

    expect(visibleObjects(describeLocation("/todos/b/platform", "?person=%40operator"))).toEqual([
      { id: "ABC-3", title: "Named by account" },
    ])
  })

  it("leaves out a column the status filter has taken off the board", () => {
    // `?status=executing` is a board of one column, and the others keep whatever
    // they loaded on the way in.
    const filters: TodoFilters = { status: "open" }
    seedColumn("executing", filters, [{ id: "ABC-1", title: "Ship the orb" }])
    seedColumn("backlog", filters, [{ id: "ABC-9", title: "Not on this board" }])

    expect(visibleObjects(describeLocation("/todos/b/platform", "?status=executing"))).toEqual([
      { id: "ABC-1", title: "Ship the orb" },
    ])
  })

  it("finds the cards of a filter the operator typed with spaces around it", () => {
    // The board keys its columns off the same parser, so a padded value has to
    // canonicalize on the way in: without that the page renders these cards and
    // the snapshot looks them up under a key nobody ever wrote.
    const filters = filtersFromSearchParams(new URLSearchParams("assignee=%20scout%20"))
    seedColumn("executing", filters, [{ id: "ABC-3", title: "Assigned with a stray space" }])

    expect(visibleObjects(describeLocation("/todos/b/platform", "?assignee=%20scout%20"))).toEqual([
      { id: "ABC-3", title: "Assigned with a stray space" },
    ])
  })

  it("answers with nothing when the cache is cold", () => {
    expect(visibleObjects(describeLocation("/todos/b/platform", ""))).toEqual([])
  })
})
