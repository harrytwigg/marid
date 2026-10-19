import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { requestTodoPreview } from "@/lib/todo-preview"
import { useSetWorkItemStatus } from "../use-todos"
import { mergeTodoIntoCaches } from "../todo-edit-request"

const setWorkItemStatus = vi.fn()
const getWorkItems = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      getWorkItems: (...args: unknown[]) => getWorkItems(...args),
    },
  }
})

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(["work-items", "board", "platform", "executing"], {
    pages: [{ workItems: [{ id: "TSK-3", version: 4, status: "executing" }], total: 1, nextOffset: null }],
    pageParams: [0],
  })
  client.setQueryData(["work-item", "TSK-3"], {
    workItem: { id: "TSK-3", version: 4, status: "executing" },
    spendUsd: 0,
  })
  client.setQueryData(["work-item-preview", "TSK-3"], {
    workItem: { id: "TSK-3", version: 4, status: "executing" },
    spendUsd: 0,
    events: [],
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useSetWorkItemStatus(), { wrapper })
  return { client, mutation: hook.result }
}

function boardStatus(client: QueryClient): string | undefined {
  const board = client.getQueryData<{
    pages: Array<{ workItems: Array<{ id: string; status: string }> }>
  }>(["work-items", "board", "platform", "executing"])
  return board?.pages[0]?.workItems[0]?.status
}

function detailStatus(client: QueryClient): string | undefined {
  return client.getQueryData<{ workItem: { status: string } }>(["work-item", "TSK-3"])?.workItem.status
}

function detailVersion(client: QueryClient): number | undefined {
  return client.getQueryData<{ workItem: { version: number } }>(["work-item", "TSK-3"])?.workItem.version
}

function previewStatus(client: QueryClient): string | undefined {
  return client.getQueryData<{ workItem: { status: string } }>(["work-item-preview", "TSK-3"])?.workItem.status
}

describe("Todo status mutation caches", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWorkItems.mockImplementation((ids: string[]) =>
      Promise.resolve({ workItems: ids.map((id) => ({ workItem: { id, status: "executing" }, events: [] })) }))
  })

  it("updates board and detail caches immediately, then restores both on rejection", async () => {
    let rejectRequest!: (error: Error) => void
    setWorkItemStatus.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
    const { client, mutation } = setup()

    act(() => mutation.current.mutate({ id: "TSK-3", status: "in_review" }))

    await waitFor(() => {
      expect(boardStatus(client)).toBe("in_review")
      expect(detailStatus(client)).toBe("in_review")
      expect(previewStatus(client)).toBe("in_review")
    })

    act(() => rejectRequest(new Error("refused")))
    await waitFor(() => {
      expect(boardStatus(client)).toBe("executing")
      expect(detailStatus(client)).toBe("executing")
      expect(previewStatus(client)).toBe("executing")
    })
  })

  it("leaves the confirmed status in the preview cache and re-asks the gateway for it", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: { id: "TSK-3", version: 5, status: "in_review" }, escalated: false })
    const { client, mutation } = setup()
    // Warm the batch cache the mention queryFn resolves out of, so a preview
    // that survived the write would be observable as a missing second request.
    await requestTodoPreview("TSK-3")
    expect(getWorkItems).toHaveBeenCalledTimes(1)

    act(() => mutation.current.mutate({ id: "TSK-3", status: "in_review" }))
    await waitFor(() => expect(mutation.current.isSuccess).toBe(true))

    expect(previewStatus(client)).toBe("in_review")
    await requestTodoPreview("TSK-3")
    expect(getWorkItems).toHaveBeenCalledTimes(2)
  })

  /** Two rapid writes of the same move — a re-fired commit. The second one is
   *  confirmed at version 5 while the first is still in flight; when the first
   *  then fails, its rollback is holding a version-4 snapshot of a value the
   *  Todo has genuinely left behind. Banking the second response is what gives
   *  the version fence in rollbackTodoStatus something to weigh, and the fence
   *  is what keeps the confirmed value. Nothing here is staged by hand. */
  it("does not resurrect the pre-write status when a re-fired write is confirmed first", async () => {
    let rejectFirst!: (error: Error) => void
    setWorkItemStatus
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ workItem: { id: "TSK-3", version: 5, status: "in_review" }, escalated: false })
    const { client, mutation } = setup()

    act(() => mutation.current.mutate({ id: "TSK-3", status: "in_review" }))
    act(() => mutation.current.mutate({ id: "TSK-3", status: "in_review" }))
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(detailVersion(client)).toBe(5))

    act(() => rejectFirst(new Error("conflict")))
    await waitFor(() => expect(mutation.current.isSuccess).toBe(true))
    expect(boardStatus(client)).toBe("in_review")
    expect(detailStatus(client)).toBe("in_review")
    expect(previewStatus(client)).toBe("in_review")
  })

  it("does not roll a newer live payload back after the request rejects", async () => {
    let rejectRequest!: (error: Error) => void
    setWorkItemStatus.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
    const { client, mutation } = setup()

    act(() => mutation.current.mutate({ id: "TSK-3", status: "in_review" }))
    await waitFor(() => expect(detailStatus(client)).toBe("in_review"))

    act(() => mergeTodoIntoCaches(client, { id: "TSK-3", version: 5, status: "done" }))
    expect(boardStatus(client)).toBe("done")
    expect(detailStatus(client)).toBe("done")

    act(() => rejectRequest(new Error("refused")))
    await waitFor(() => {
      expect(mutation.current.isError).toBe(true)
      expect(boardStatus(client)).toBe("done")
      expect(detailStatus(client)).toBe("done")
      expect(detailVersion(client)).toBe(5)
    })
  })
})
