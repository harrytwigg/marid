import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemAttachmentWire, WorkItemDetailWire, WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* ICI-1439 — the whole Todo detail view takes a file drag, and every file in a
 * drop is its own upload: one refusal reports itself by name and the rest of
 * the batch still lands. The paperclip picker shares that path, so it is
 * asserted alongside rather than trusted to have stayed in step. */

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const listWorkItemAttachments = vi.fn()
const listWorkItemComments = vi.fn()
const listWorkItemSessions = vi.fn()
const uploadWorkItemAttachment = vi.fn()
const getOrg = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: vi.fn(),
      listWorkItemAttachments: (...args: unknown[]) => listWorkItemAttachments(...args),
      listWorkItemComments: (...args: unknown[]) => listWorkItemComments(...args),
      uploadWorkItemAttachment: (...args: unknown[]) => uploadWorkItemAttachment(...args),
      deleteWorkItemAttachment: vi.fn(),
      workItemAttachmentUrl: (id: string, attachmentId: string) =>
        `/api/work-items/${id}/attachments/${attachmentId}`,
      listWorkItemSessions: (...args: unknown[]) => listWorkItemSessions(...args),
      dispatchTodo: vi.fn(),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }],
      }),
      getOrg: (...args: unknown[]) => getOrg(...args),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string): WorkItemFullWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
    body: null,
    status: "executing",
    department: "platform",
    assignee: null,
    priority: 2,
    rank: null,
    source: "human",
    sourceRef: null,

    rounds: 1,
    budgetUsd: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null,
  }
}

function attachmentWire(filename: string, index: number): WorkItemAttachmentWire {
  return {
    id: `wia_${index}`,
    workItemId: "PLA-12",
    commentId: null,
    filename,
    mime: "application/pdf",
    bytes: 1024,
    sha256: `sha-${index}`,
    storagePath: `attachments/${filename}`,
    uploadedBy: "operator",
    createdAt: "2026-07-23T08:00:00.000Z",
  }
}

function detailOf(item: WorkItemFullWire): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [] }
}

function treeNode(item: WorkItemFullWire): WorkItemTreeNodeWire {
  return { ...item, children: [] }
}

/** Only a drag carrying files opens the overlay; the rest belong to other DnD. */
function fileTransfer(files: File[]): DataTransfer {
  return { types: ["Files"], files } as unknown as DataTransfer
}

/** What a sub-task reorder puts on the wire: a payload, and no files. */
function reorderTransfer(): DataTransfer {
  return { types: ["application/x-jinn-todo"], files: [] } as unknown as DataTransfer
}

function fireDrag(
  target: HTMLElement,
  kind: "dragEnter" | "dragLeave" | "drop",
  dataTransfer: DataTransfer,
): Event {
  const event = createEvent[kind](target, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer })
  fireEvent(target, event)
  return event
}

function renderTask() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/PLA-12"]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The loaded page — the skeleton is not a drop target — and its scroll body. */
async function mountedTask(): Promise<HTMLElement> {
  renderTask()
  await screen.findByTestId("task-attachments")
  return screen.getByTestId("task-page-scroll")
}

function pdf(name: string): File {
  return new File(["x"], name, { type: "application/pdf" })
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
  listWorkItemAttachments.mockResolvedValue({ attachments: [] })
  listWorkItemComments.mockResolvedValue({ comments: [], total: 0 })
  listWorkItemSessions.mockResolvedValue([])
  uploadWorkItemAttachment.mockResolvedValue(attachmentWire("a.pdf", 0))
  getOrg.mockResolvedValue({
    departments: ["platform"],
    employees: [],
    hierarchy: { root: null, sorted: [], warnings: [] },
  })
})

describe("dropping files on the Todo detail view", () => {
  it("shows the overlay for a file drag and ignores a drag carrying no files", async () => {
    const surface = await mountedTask()

    fireDrag(surface, "dragEnter", fileTransfer([pdf("a.pdf")]))
    expect(screen.getByTestId("file-drop-overlay")).toBeTruthy()

    fireDrag(surface, "dragLeave", fileTransfer([pdf("a.pdf")]))
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull()

    const foreign = fireDrag(surface, "dragEnter", reorderTransfer())
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull()
    expect(foreign.defaultPrevented).toBe(false)
  })

  it("clears the overlay on drop and on Escape", async () => {
    const surface = await mountedTask()

    fireDrag(surface, "drop", fileTransfer([pdf("a.pdf")]))
    await waitFor(() => expect(screen.queryByTestId("file-drop-overlay")).toBeNull())

    fireDrag(surface, "dragEnter", fileTransfer([pdf("b.pdf")]))
    expect(screen.getByTestId("file-drop-overlay")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("file-drop-overlay")).toBeNull()
  })

  it("uploads every file in the drop and shows them all once the list settles", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]
    listWorkItemAttachments
      .mockResolvedValueOnce({ attachments: [] })
      .mockResolvedValue({ attachments: files.map((file, index) => attachmentWire(file.name, index)) })
    const surface = await mountedTask()

    fireDrag(surface, "drop", fileTransfer(files))

    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledTimes(3))
    expect(uploadWorkItemAttachment.mock.calls.map(([id, file]) => [id, (file as File).name])).toEqual([
      ["PLA-12", "a.pdf"],
      ["PLA-12", "b.pdf"],
      ["PLA-12", "c.pdf"],
    ])
    const strip = await screen.findByTestId("attachment-strip")
    await waitFor(() => expect(within(strip).getAllByText(/\.pdf$/)).toHaveLength(3))
  })

  it("finishes the batch when one file is refused and names only that file", async () => {
    uploadWorkItemAttachment
      .mockResolvedValueOnce(attachmentWire("a.pdf", 0))
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(attachmentWire("c.pdf", 2))
    const surface = await mountedTask()

    fireDrag(surface, "drop", fileTransfer([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]))

    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledTimes(3))
    const callouts = await screen.findAllByTestId("task-callout")
    expect(callouts).toHaveLength(1)
    expect(callouts[0].textContent).toBe("Couldn't attach b.pdf")
  })

  it("takes a drop from the Activity feed and from the properties rail", async () => {
    await mountedTask()

    fireDrag(screen.getByTestId("task-activity"), "drop", fileTransfer([pdf("activity.pdf")]))
    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledTimes(1))

    fireDrag(screen.getByTestId("task-props-rail"), "drop", fileTransfer([pdf("rail.pdf")]))
    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledTimes(2))
    expect(uploadWorkItemAttachment.mock.calls.map(([, file]) => (file as File).name)).toEqual([
      "activity.pdf",
      "rail.pdf",
    ])
  })
})

describe("the paperclip picker", () => {
  it("runs the same batch: every file attempted, the refused one named once", async () => {
    uploadWorkItemAttachment
      .mockResolvedValueOnce(attachmentWire("a.pdf", 0))
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce(attachmentWire("c.pdf", 2))
    await mountedTask()

    fireEvent.change(screen.getByTestId("attachment-file-input"), {
      target: { files: [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")] },
    })

    await waitFor(() => expect(uploadWorkItemAttachment).toHaveBeenCalledTimes(3))
    const callouts = await screen.findAllByTestId("task-callout")
    expect(callouts).toHaveLength(1)
    expect(callouts[0].textContent).toBe("Couldn't attach b.pdf")
  })
})
