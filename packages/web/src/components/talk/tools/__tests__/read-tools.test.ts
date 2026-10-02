import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { api } from "@/lib/api"
import { executeToolCall } from "../registry"
import { clip, trimSession } from "../read-shapes"

vi.mock("@/lib/api", () => ({
  api: {
    getWorkItem: vi.fn(),
    getSession: vi.fn(),
  },
}))

const mocked = vi.mocked(api)

const TODO = {
  workItem: {
    id: "ABC-59", title: "Ship the orb", status: "executing", assignee: "a-lead",
    department: "platform", parentId: null, dueAt: null, updatedAt: "2026-01-02T03:04:05Z",
    body: "  The   body.  ",
  },
  labels: [{ id: "l1", name: "build" }],
  comments: { total: 7, comments: Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`, author: `author-${i}`, createdAt: "2026-01-02T00:00:00Z", body: `comment ${i}`,
  })) },
}

beforeEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

afterEach(() => queryClient.clear())

/** Seeded as the app leaves it after the operator has been sitting on a page for
 *  a while: present, and past its staleTime. A refetch here would stall a voice
 *  turn on the network to re-learn what the screen is already showing. */
function warm(key: unknown[], data: unknown) {
  queryClient.setQueryData(key, data, { updatedAt: 0 })
}

describe("a warm cache answers without touching the network", () => {
  it("reads a Todo from the entry its own page fills", async () => {
    warm(["work-item", "ABC-59"], TODO)

    const result = await executeToolCall("read_todo", '{"id":"ABC-59"}')

    expect(mocked.getWorkItem).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.data.title).toBe("Ship the orb")
    expect(result.data.labels).toEqual(["build"])
    expect(result.data.body).toBe("The body.")
    // Trimmed for a voice model: the count is honest, the payload is the tail.
    expect(result.data.commentCount).toBe(7)
    expect(result.data.comments).toHaveLength(5)
  })

  it("reads a session the same way", async () => {
    warm([...queryKeys.sessions.detail("s1")], {
      id: "s1", title: "Orb work", employee: "a-lead", status: "running",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    })

    const session = await executeToolCall("read_session", '{"id":"s1"}')

    expect(mocked.getSession).not.toHaveBeenCalled()
    expect(session.ok && session.data.status).toBe("running")
    expect(session.ok && session.data.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ])
  })
})

describe("a cold miss falls through and fills the cache", () => {
  it("fetches once, then serves the second call from the cache it populated", async () => {
    mocked.getWorkItem.mockResolvedValue(TODO as never)

    const first = await executeToolCall("read_todo", '{"id":"ABC-59","comments":false}')
    const second = await executeToolCall("read_todo", '{"id":"ABC-59"}')

    expect(mocked.getWorkItem).toHaveBeenCalledTimes(1)
    expect(first.ok && first.data.comments).toBeUndefined()
    expect(second.ok && second.data.comments).toHaveLength(5)
  })

  it("refetches a session the app cached without its messages", async () => {
    // What the Talk object renderer leaves on this
    // key: api.getSession(id, { messages: false }). Answering from it would read
    // out "no messages" for a busy session, so it is a miss, not a cheap hit.
    warm([...queryKeys.sessions.detail("s2")], { id: "s2", title: "Orb work", status: "running" })
    mocked.getSession.mockResolvedValue({
      id: "s2", title: "Orb work", status: "running",
      messages: [{ role: "user", content: "where are we" }],
    } as never)

    const result = await executeToolCall("read_session", '{"id":"s2"}')

    expect(mocked.getSession).toHaveBeenCalledWith("s2", { last: 6 })
    expect(result.ok && result.data.messageCount).toBe(1)
    expect(result.ok && result.data.messages).toEqual([{ role: "user", text: "where are we" }])
  })

  it("refetches around a messages:false request that is still in flight", async () => {
    // The settled entry is only half the hazard: react-query deduplicates by
    // key, so a partial request the sessions page still has open would answer
    // this one with its own half of the object.
    const key = [...queryKeys.sessions.detail("s3")]
    let landPartial: (session: unknown) => void = () => {}
    const partialBody = new Promise((resolve) => { landPartial = resolve })
    const partial = queryClient.fetchQuery({ queryKey: key, queryFn: () => partialBody })
    await vi.waitFor(() => expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching"))
    mocked.getSession.mockResolvedValue({
      id: "s3", title: "Orb work", status: "running",
      messages: [{ role: "user", content: "still here" }],
    } as never)

    const reading = executeToolCall("read_session", '{"id":"s3"}')
    landPartial({ id: "s3", title: "Orb work", status: "running" })
    const result = await reading

    expect(result.ok && result.data.messages).toEqual([{ role: "user", text: "still here" }])
    await partial
  })

  it("reports a failed read rather than throwing into the caller", async () => {
    mocked.getSession.mockRejectedValue(new Error("gateway is down"))
    await expect(executeToolCall("read_session", '{"id":"missing"}')).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("gateway is down"),
    })
  })
})

describe("the trimmed shapes", () => {
  it("marks a truncation instead of hiding it", () => {
    expect(clip("a".repeat(12), 8)).toBe(`${"a".repeat(8)}… (truncated)`)
    expect(clip("short", 8)).toBe("short")
    expect(clip(undefined, 8)).toBe("")
  })

  it("reads an untyped session record defensively", () => {
    expect(trimSession({}, "s9")).toEqual({
      id: "s9", title: null, employee: null, status: null, lastActivity: null,
      messageCount: 0, messages: [],
    })
    // Older sessions carry their rows under `history` instead of `messages`.
    expect(trimSession({ history: [{ role: "user", content: "x" }] }, "s9").messageCount).toBe(1)
  })
})
