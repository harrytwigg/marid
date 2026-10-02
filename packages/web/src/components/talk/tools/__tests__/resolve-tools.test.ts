import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { clearTalkNavigator, registerTalkNavigator } from "../router-handle"
import { executeToolCall } from "../registry"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    searchWorkItems: vi.fn(),
    searchSessions: vi.fn(),
  },
}))

const mocked = vi.mocked(api)
const visited: string[] = []

/** Every source answers empty unless a case says otherwise, so "nothing was
 *  searched" and "nothing was found" stay distinguishable. */
function findNothing() {
  mocked.searchWorkItems.mockResolvedValue({ workItems: [] } as never)
  mocked.searchSessions.mockResolvedValue([] as never)
}

function searchCalls(): number {
  return Object.values(mocked).reduce((total, fn) => total + fn.mock.calls.length, 0)
}

function open(what: string): Promise<{ ok: boolean; error?: string }> {
  return executeToolCall("resolve_and_open", JSON.stringify({ what })) as Promise<{ ok: boolean; error?: string }>
}

beforeEach(() => {
  vi.clearAllMocks()
  visited.length = 0
  findNothing()
  registerTalkNavigator((path) => {
    visited.push(path)
    return Promise.resolve()
  })
  queryClient.setQueryData(queryKeys.onboarding, { todoPrefix: "ZZZ" })
  window.history.replaceState({}, "", "/todos/b/home")
})

afterEach(() => {
  clearTalkNavigator()
  queryClient.clear()
})

describe("an id costs nothing to resolve", () => {
  it.each(["ABC-744", "abc 744"])("opens %s without issuing a single search", async (what) => {
    expect(await open(what)).toEqual({ ok: true, data: { path: "/todos/ABC-744" } })
    expect(visited).toEqual(["/todos/ABC-744"])
    expect(searchCalls()).toBe(0)
  })

  it("takes a bare number's prefix from the Todo the operator is looking at", async () => {
    window.history.replaceState({}, "", "/todos/ABC-701")
    await open("744")
    expect(visited).toEqual(["/todos/ABC-744"])
    expect(searchCalls()).toBe(0)
  })

  it("falls back to the instance default on a route that carries no prefix", async () => {
    await open("744")
    expect(visited).toEqual(["/todos/ZZZ-744"])
  })

  it("asks for the prefix rather than guessing when there is neither", async () => {
    queryClient.setQueryData(queryKeys.onboarding, { todoPrefix: null })
    const result = await open("744")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("prefix")
    expect(visited).toEqual([])
    expect(searchCalls()).toBe(0)
  })
})

/** One lone match per kind, so the three sources and their three routes are each
 *  proven rather than the Todo path standing in for all of them. */
const KINDS = [
  { kind: "todo", path: "/todos/ABC-744", fill: () => mocked.searchWorkItems.mockResolvedValue({ workItems: [{ id: "ABC-744", title: "Talk orb resolution", status: "executing" }] } as never) },
  { kind: "session", path: "/?session=s-1", fill: () => mocked.searchSessions.mockResolvedValue([{ id: "s-1", title: "Talk orb resolution", employee: "a-lead" }] as never) },
]

describe("a description opens the one thing it fits", () => {
  it.each(KINDS)("navigates to the only matching $kind", async ({ path, fill }) => {
    fill()
    const result = await open("the talk orb resolution one")
    expect(result.ok).toBe(true)
    expect(visited).toEqual([path])
  })

  it("says out loud that nothing matched, and opens nothing", async () => {
    const result = await open("the deployment pipeline")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Nothing")
    expect(visited).toEqual([])
  })
})

describe("a description is looked for by every word it holds", () => {
  /** Two things whose titles the longest spoken word — "thing" — never reaches. */
  const ORB_SESSIONS = [
    { id: "s-1", title: "Talk orb resolution", employee: "a-lead" },
    { id: "s-2", title: "Talk orb latency", employee: "a-lead" },
  ]

  it("finds what the longest word alone would miss, and asks which out loud", async () => {
    mocked.searchSessions.mockImplementation((term) =>
      Promise.resolve(term === "thing" ? [] : ORB_SESSIONS) as never)
    const result = await open("talk orb thing")

    expect(mocked.searchSessions.mock.calls.map(([term]) => term)).toEqual(
      expect.arrayContaining(["talk", "orb"]),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain("ambiguous")
    expect(result.error).toContain("Talk orb resolution (Chat, s-1")
    expect(result.error).toContain("Talk orb latency (Chat, s-2")
    expect(visited).toEqual([])
  })

  it("counts one object once, however many of its words were searched", async () => {
    mocked.searchWorkItems.mockResolvedValue({
      workItems: [{ id: "ABC-744", title: "Talk orb resolution", status: "executing" }],
    } as never)
    expect(await open("talk orb resolution")).toEqual({ ok: true, data: { path: "/todos/ABC-744" } })
    expect(visited).toEqual(["/todos/ABC-744"])
  })
})

describe("several matches are spoken, never guessed between", () => {
  beforeEach(() => {
    mocked.searchWorkItems.mockResolvedValue({
      workItems: [
        { id: "ABC-744", title: "Talk orb resolution", status: "executing" },
        { id: "ABC-745", title: "Talk orb latency", status: "backlog" },
      ],
    } as never)
  })

  it("returns ranked candidates for Aurora to ask about", async () => {
    const result = await open("talk orb")

    expect(result.ok).toBe(false)
    expect(result.error).toContain("Talk orb resolution (Todo, ABC-744, executing)")
    expect(result.error).toContain("Talk orb latency (Todo, ABC-745, backlog)")
    expect(visited).toEqual([])
  })
})
