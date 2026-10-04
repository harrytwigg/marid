import { describe, it, expect } from "vitest"
import { ApiError, TodoApiError, type WorkItemCompactWire, type WorkItemStatusWire } from "../api"
import {
  stateKeyOf,
  deriveNeedsYou,
  provenanceSuffix,
  provenanceLabel,
  compareRank,
  rankBetween,
  activeFilterCount,
  matchesDueFilter,
  filtersToSearchParams,
  filtersFromSearchParams,
  hasFilterParams,
  readPersistedFilters,
  writePersistedFilters,
  BOARD_FILTERS_STORAGE_KEY,
  dateBucketOf,
  groupHistory,
  isTodoVersionConflictError,
  isTodoIdempotencyConflictError,
  operatorSafeTodoError,
  type TodoFilters,
} from "../todos"

const NOW = Date.parse("2026-07-05T12:00:00.000Z")

function compact(over: Partial<WorkItemCompactWire> & { id: string; status: WorkItemStatusWire }): WorkItemCompactWire {
  return {
    title: over.title ?? over.id,
    assignee: over.assignee ?? null,
    department: over.department ?? null,
    source: over.source ?? "human",
    updatedAt: over.updatedAt ?? "2026-07-05T11:00:00.000Z",
    ...over,
    sourceRef: over.sourceRef ?? null,
  }
}

describe("stateKeyOf", () => {
  it("keeps the true glyph key — blocked stays itself, in_review maps to review", () => {
    expect(stateKeyOf("in_review")).toBe("review")
    expect(stateKeyOf("blocked")).toBe("blocked")
    expect(stateKeyOf("executing")).toBe("executing")
  })
})

describe("conditional edit errors", () => {
  it("classifies only the typed idempotency conflict code", () => {
    expect(isTodoIdempotencyConflictError(new TodoApiError(409, "private", "todo_idempotency_conflict"))).toBe(true)
    expect(isTodoIdempotencyConflictError(new TodoApiError(409, "private", "todo_version_conflict"))).toBe(false)
    expect(isTodoIdempotencyConflictError(new Error("TODO_IDEMPOTENCY_CONFLICT"))).toBe(false)
  })

  it.each([
    "todo_version_conflict",
    "WORK_ITEM_VERSION_CONFLICT",
  ])("classifies the explicit %s code as a version conflict", (code) => {
    expect(isTodoVersionConflictError(new TodoApiError(400, "private diagnostic", code))).toBe(true)
  })

  it.each([
    new TodoApiError(409, "generic conflict"),
    new TodoApiError(412, "generic precondition"),
    new TodoApiError(409, "different conflict", "todo_idempotency_conflict"),
    new Error("WORK_ITEM_VERSION_CONFLICT"),
  ])("does not route a non-version error to reconciliation", (error) => {
    expect(isTodoVersionConflictError(error)).toBe(false)
  })

  it.each([
    ["todo_idempotency_conflict", "This edit request conflicts with an earlier request. Reload remote to discard all local edits before starting a new edit."],
    ["todo_precondition_required", "This Todo requires a current version before it can be saved. Reload it and try again."],
    ["todo_invalid_version", "This Todo version is invalid. Reload it and try again."],
    ["todo_invalid_patch", "This Todo edit is invalid. Review the changed fields and try again."],
    ["todo_already_executing", "Someone is already working this Todo. Message their session instead of dispatching it again."],
  ])("uses closed safe copy for %s without exposing backend diagnostics", (code, safeCopy) => {
    const error = new TodoApiError(400, "SQLITE_BUSY /srv/private.db token=secret", code)

    expect(operatorSafeTodoError(error, "Safe fallback")).toBe(safeCopy)
    expect(error).toMatchObject({
      name: "TodoApiError",
      code,
      message: "SQLITE_BUSY /srv/private.db token=secret",
    })
    expect(operatorSafeTodoError(error, "Safe fallback")).not.toMatch(/SQLITE_BUSY|private\.db|secret/)
    expect(error).toBeInstanceOf(ApiError)
  })
})



describe("deriveNeedsYou", () => {
  it("preserves the server's updated-first order and only keeps attention items", () => {
    const items = [
      compact({ id: "blk1", status: "blocked" }),
      compact({ id: "review1", status: "in_review" }),
      compact({ id: "blk2", status: "blocked" }),
      compact({ id: "done1", status: "done" }),
    ]
    const set = deriveNeedsYou(items)
    expect(set.map((item) => item.id)).toEqual(["blk1", "blk2"])
    expect(set).toHaveLength(2)
  })
  it("is empty when nothing is blocked", () => {
    expect(deriveNeedsYou([compact({ id: "x", status: "executing" })])).toHaveLength(0)
  })

  // PLA-157: the board's "N waiting" reads this set, so a Todo waiting out a
  // quota window must not be counted as a Todo waiting on a person.
  it("drops an unexpired park, and keeps one that has run out or will not parse", () => {
    const ahead = new Date(NOW + 3_600_000).toISOString()
    const behind = new Date(NOW - 3_600_000).toISOString()
    const items = [
      compact({ id: "parked", status: "blocked", parkedUntil: ahead }),
      compact({ id: "expired", status: "blocked", parkedUntil: behind }),
      compact({ id: "unreadable", status: "blocked", parkedUntil: "whenever" }),
      compact({ id: "plain", status: "blocked" }),
    ]
    expect(deriveNeedsYou(items, NOW).map((item) => item.id)).toEqual(["expired", "unreadable", "plain"])
  })

  it("keeps recovering and manager lanes so they reach the dashboard groups", () => {
    const parked = new Date(NOW + 3_600_000).toISOString()
    const set = deriveNeedsYou([
      compact({ id: "rec-backlog", status: "backlog", attentionLane: "recovering" }),
      compact({ id: "rec-parked", status: "blocked", attentionLane: "recovering", parkedUntil: parked }),
      compact({ id: "mgr-review", status: "in_review", attentionLane: "manager" }),
      compact({ id: "plain-backlog", status: "backlog" }),
    ], NOW)
    expect(set.map((item) => item.id)).toEqual(["rec-backlog", "rec-parked", "mgr-review"])
  })
})



describe("provenance whisper", () => {
  it("parses the machine-minted sourceRef suffix for cron and workflow", () => {
    expect(provenanceSuffix("cron", "cron:daily-digest:2026-07-05T09:00:00Z")).toBe("daily-digest")
    expect(provenanceSuffix("workflow", "workflow:release-train:run_9")).toBe("release-train")
    expect(provenanceSuffix("human", "anything")).toBeNull()
    expect(provenanceSuffix("cron", null)).toBeNull()
  })
  it("labels provenance with the suffix when present and never leaks transport ids", () => {
    expect(provenanceLabel("cron", "cron:daily-digest:2026-07-05T09:00:00Z")).toBe("Cron · daily-digest")
    expect(provenanceLabel("human", null)).toBe("You")
    expect(provenanceLabel("workflow", "workflow:wi_private_def:run")).toBe("Workflow")
  })
})

describe("manual rank (design-todos §4.5/§7.3)", () => {
  it("orders ranked items ascending, ranked before unranked, unranked by updatedAt desc", () => {
    const a = compact({ id: "a", status: "backlog", rank: 2 })
    const b = compact({ id: "b", status: "backlog", rank: 1 })
    const c = compact({ id: "c", status: "backlog", updatedAt: "2026-07-05T10:00:00.000Z" })
    const d = compact({ id: "d", status: "backlog", updatedAt: "2026-07-05T11:30:00.000Z" })
    const sorted = [a, b, c, d].sort(compareRank)
    expect(sorted.map((i) => i.id)).toEqual(["b", "a", "d", "c"])
  })
  it("computes midpoints and open-ended edge ranks", () => {
    expect(rankBetween(1, 3)).toBe(2)
    expect(rankBetween(5, null)).toBe(5 + 1024)
    expect(rankBetween(null, 5)).toBe(5 - 1024)
    expect(rankBetween(null, null)).toBe(0)
  })
})

describe("filters (design-todos §4.3)", () => {
  it("round-trips through URL search params", () => {
    const f: TodoFilters = { status: "done", assignee: "jinn-dev", department: "platform", source: "cron", date: "week", label: "infra", due: "overdue", q: "digest" }
    expect(filtersFromSearchParams(filtersToSearchParams(f))).toEqual(f)
    expect(filtersFromSearchParams(new URLSearchParams("due=nonsense"))).toEqual({ status: "open" })
    // Defaults serialize to an empty string (clean URLs).
    expect(filtersToSearchParams({ status: "open" }).toString()).toBe("")
    expect(filtersToSearchParams({ status: "open", q: "wi_private_42" }).toString()).toBe("")
    expect(filtersFromSearchParams(new URLSearchParams("q=wi_private_42"))).toEqual({ status: "open" })
    expect(filtersFromSearchParams(new URLSearchParams())).toEqual({ status: "open" })
    // Garbage params are ignored, not thrown.
    expect(filtersFromSearchParams(new URLSearchParams("status=nope&source=bad&date=huh"))).toEqual({ status: "open" })
  })
  it("trims the free-text values, so a padded URL reads as the filter it names", () => {
    expect(filtersFromSearchParams(new URLSearchParams("assignee=%20scout%20&department=%20platform%20&label=%20build%20")))
      .toEqual({ status: "open", assignee: "scout", department: "platform", label: "build" })
    // Whitespace alone is not a filter set to nothing — it is no filter at all.
    expect(filtersFromSearchParams(new URLSearchParams("assignee=%20%20"))).toEqual({ status: "open" })
  })

  it("counts set chips for the Clear control", () => {
    expect(activeFilterCount({ status: "open" })).toBe(0)
    expect(activeFilterCount({ status: "open", q: "roadmap" })).toBe(0)
    expect(activeFilterCount({ status: "done", assignee: "x", date: "today" })).toBe(3)
    expect(activeFilterCount({ status: "open", label: "infra", due: "week" })).toBe(2)
  })

  it("due windows filter client-side: forward-looking windows from start of today, Overdue strictly past", () => {
    // NOW = 2026-07-05T12:00Z (a Sunday); windows use local midnight.
    expect(matchesDueFilter(null, "week", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-06T00:00:00.000Z", undefined, NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-05T09:00:00.000Z", "overdue", NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-05T13:00:00.000Z", "overdue", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-05T13:00:00.000Z", "today", NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-06T13:00:00.000Z", "today", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-09T13:00:00.000Z", "week", NOW)).toBe(true)
    expect(matchesDueFilter("2026-07-20T13:00:00.000Z", "week", NOW)).toBe(false)
    expect(matchesDueFilter("2026-07-20T13:00:00.000Z", "month", NOW)).toBe(true)
    expect(matchesDueFilter("2026-09-20T13:00:00.000Z", "month", NOW)).toBe(false)
    // Yesterday's overdue item is NOT "due this week" — Overdue is its lens.
    expect(matchesDueFilter("2026-07-04T09:00:00.000Z", "week", NOW)).toBe(false)
    expect(matchesDueFilter("invalid", "week", NOW)).toBe(false)
  })
})

describe("filter persistence (board survives a return, a board switch and a new tab)", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      dump: () => Object.fromEntries(map),
    }
  }

  it("reads a filtered URL as a filtered view, an empty one as unfiltered", () => {
    expect(hasFilterParams(new URLSearchParams("sprint=active"))).toBe(true)
    expect(hasFilterParams(new URLSearchParams("assignee=scout&label=infra"))).toBe(true)
    expect(hasFilterParams(new URLSearchParams("q=roadmap"))).toBe(true)
    // `status=open` is an explicit ask for the default, not an empty URL.
    expect(hasFilterParams(new URLSearchParams("status=open"))).toBe(true)
    expect(hasFilterParams(new URLSearchParams(""))).toBe(false)
    expect(hasFilterParams(new URLSearchParams("view=needs"))).toBe(false)
    expect(hasFilterParams(new URLSearchParams("wi_private=1"))).toBe(false)
  })

  it("round-trips the whole set, sprint included, through storage", () => {
    const storage = memoryStorage()
    const f: TodoFilters = { status: "executing", assignee: "scout", department: "platform", source: "cron", date: "week", label: "infra", sprint: "active", due: "overdue" }
    writePersistedFilters(f, storage)
    expect(readPersistedFilters(storage)).toEqual(f)
    expect(storage.dump()[BOARD_FILTERS_STORAGE_KEY]).toBe(filtersToSearchParams(f).toString())
  })

  it("clears the key for a default set, so 'nothing set' is unambiguous", () => {
    const storage = memoryStorage({ [BOARD_FILTERS_STORAGE_KEY]: "sprint=active" })
    writePersistedFilters({ status: "open" }, storage)
    expect(storage.dump()[BOARD_FILTERS_STORAGE_KEY]).toBeUndefined()
    expect(readPersistedFilters(storage)).toBeNull()
  })

  it("never resurrects a private transport id and ignores unreadable values", () => {
    const storage = memoryStorage({ [BOARD_FILTERS_STORAGE_KEY]: "q=wi_private_42" })
    expect(readPersistedFilters(storage)).toBeNull()
    const garbage = memoryStorage({ [BOARD_FILTERS_STORAGE_KEY]: "not an object" })
    expect(readPersistedFilters(garbage)).toBeNull()
    expect(readPersistedFilters(memoryStorage())).toBeNull()
  })

  it("survives a storage that throws (private mode, quota)", () => {
    const hostile = {
      getItem: () => { throw new Error("denied") },
      setItem: () => { throw new Error("denied") },
      removeItem: () => { throw new Error("denied") },
    }
    expect(() => writePersistedFilters({ status: "executing" }, hostile)).not.toThrow()
    expect(readPersistedFilters(hostile)).toBeNull()
  })
})

describe("history grouping (design-todos §3)", () => {
  it("buckets by day and drops empty buckets, newest-first inside each", () => {
    // NOW = 2026-07-05T12:00Z; local-midnight boundaries make same-day safe picks.
    expect(dateBucketOf("2026-07-05T11:00:00.000Z", NOW)).toBe("today")
    expect(dateBucketOf("invalid", NOW)).toBe("earlier")
    const groups = groupHistory(
      [
        compact({ id: "t1", status: "done", updatedAt: "2026-07-05T09:00:00.000Z" }),
        compact({ id: "t2", status: "done", updatedAt: "2026-07-05T11:00:00.000Z" }),
        compact({ id: "old", status: "done", updatedAt: "2026-05-01T10:00:00.000Z" }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.bucket)).toEqual(["today", "earlier"])
    expect(groups[0].items.map((i) => i.id)).toEqual(["t2", "t1"])
    expect(groups[0].label).toBe("Today")
  })
})
