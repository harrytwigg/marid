import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* Todos v2 slice 6 — the body editor + inline title (design-doc §7.4,
 * §7.2.3/6). The stored body stays plain markdown (the editor is a view, never
 * a storage format). */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const updateWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      getWorkItemTree: vi.fn().mockRejectedValue(new Error("no tree")),
      setWorkItemStatus: vi.fn(),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
      getOrg: vi.fn().mockResolvedValue({ departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
      listLabels: vi.fn().mockResolvedValue({ labels: [] }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: null,
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null,
    rounds: 1, budgetUsd: null,
    createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null, ...overrides,
  }
}

function detailOf(item: WorkItemFullWire): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [] }
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("inline title + body editor on the page", () => {
  it("tap-to-edit title commits a PATCH on Enter and reverts on Escape", async () => {
    const item = full("PLA-12", { title: "Guest checkout" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, title: "Guest checkout v2", version: 4 }, replayed: false })
    renderTask()

    await waitFor(() => expect(screen.getByTestId("task-title").textContent).toContain("Guest checkout"))
    fireEvent.click(screen.getByTestId("task-title"))
    const input = screen.getByTestId("task-title-edit")
    fireEvent.change(input, { target: { value: "Guest checkout v2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { title: "Guest checkout v2" },
        expectedVersion: 3,
      })),
    )

    // Escape reverts without committing.
    updateWorkItem.mockClear()
    fireEvent.click(await screen.findByTestId("task-title"))
    const again = screen.getByTestId("task-title-edit")
    fireEvent.change(again, { target: { value: "Something else" } })
    fireEvent.keyDown(again, { key: "Escape" })
    expect(updateWorkItem).not.toHaveBeenCalled()
  })

  it("the body first renders stored markdown read-only (heading + list, no raw syntax)", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { body: "## Scope\n\n- E-mail-only identity\n\nShips `PLA-22` separately." })))
    renderTask()

    const body = await screen.findByTestId("task-body")
    await waitFor(() => {
      expect(body.querySelector("h2")?.textContent).toBe("Scope")
      expect(body.querySelector("li")?.textContent).toContain("E-mail-only identity")
      expect(body.querySelector("code")?.textContent).toBe("PLA-22")
    })
    expect(body.textContent).not.toContain("##")
  })

  it.each([
    ["a table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["checklist grammar", "- [x] done thing\n- [ ] open thing"],
    ["literal HTML", '<img src="x.png" alt="pic">'],
    ["setext + star bullets + 1) markers", "Heading\n=======\n\n* star bullet\n\n1) ordered"],
    ["canonical grammar", "## Scope\n\n- item\n\n`code`"],
  ])("the innocent interaction never commits — %s stays byte-identical (F1)", async (_label, storedBody) => {
    const { BodyEditor } = await import("../task-page/body-editor")
    const onCommit = vi.fn()
    render(<BodyEditor body={storedBody} editable isDark onCommit={onCommit} />)
    fireEvent.click(screen.getByTestId("task-body-read"))
    // Non-round-trippable grammars route to the raw fallback (stage-C lossy
    // story); canonical grammar keeps the live editor. Either way, focus
    // arriving and leaving with no edit commits NOTHING.
    // The live editor arrives across a lazy boundary that has to import and
    // transform the whole ProseMirror graph, which outruns waitFor's 1s default
    // when the rest of the suite is competing for the machine.
    const surface = await waitFor(
      () => {
        const el = document.querySelector<HTMLElement>("[data-testid=task-body-raw-edit], .ProseMirror, [contenteditable=true]")
        if (!el) throw new Error("no edit surface mounted")
        return el
      },
      { timeout: 4000 },
    )
    if (surface.dataset.testid === "task-body-raw-edit") {
      fireEvent.blur(surface)
    } else {
      fireEvent.focus(surface)
      fireEvent.blur(surface)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onCommit).not.toHaveBeenCalled()
  }, 10000)

  it("a remote re-seed keeps the no-edit interaction quiet too (baseline re-seeds from the editor's serialization)", async () => {
    const { BodyEditor } = await import("../task-page/body-editor")
    const onCommit = vi.fn()
    const { rerender } = render(<BodyEditor body="First." editable isDark onCommit={onCommit} />)
    // A poll delivers a non-canonical body while the read view is at rest.
    rerender(<BodyEditor body={"- [x] agent-authored line"} editable isDark onCommit={onCommit} />)
    fireEvent.click(screen.getByTestId("task-body-read"))
    fireEvent.blur(await screen.findByTestId("task-body-raw-edit"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("a canonical body keeps the LIVE editor — no raw fallback in the normal path (§7.4)", async () => {
    const { BodyEditor } = await import("../task-page/body-editor")
    render(<BodyEditor body={"## Scope\n\n- item"} editable isDark onCommit={vi.fn()} />)
    fireEvent.click(screen.getByTestId("task-body-read"))
    await waitFor(() => {
      if (!document.querySelector(".ProseMirror, [contenteditable=true]")) throw new Error("not mounted")
    })
    expect(screen.queryByTestId("task-body-raw")).toBeNull()
  })

  it("a table body reads through MarkdownView (a real <table>) and edits byte-faithfully in raw markdown", async () => {
    const { BodyEditor } = await import("../task-page/body-editor")
    const onCommit = vi.fn()
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |"
    render(<BodyEditor body={table} editable isDark onCommit={onCommit} />)
    // The lightweight read view renders the table the live editor would destroy.
    expect(screen.getByTestId("task-body-read").querySelector("table")).toBeTruthy()
    // A genuine edit commits the FULL body unnormalized — the table survives.
    fireEvent.click(screen.getByTestId("task-body-read"))
    const textarea = await screen.findByTestId("task-body-raw-edit") as HTMLTextAreaElement
    expect(textarea.value).toBe(table)
    fireEvent.change(textarea, { target: { value: `${table}\n\nA new closing line.` } })
    fireEvent.blur(textarea)
    expect(onCommit).toHaveBeenCalledTimes(1)
    const committed = onCommit.mock.calls[0][0] as string
    expect(committed).toContain("| a | b |")
    expect(committed).toContain("A new closing line.")
  })

  it("Escape reverts a raw edit without committing", async () => {
    const { BodyEditor } = await import("../task-page/body-editor")
    const onCommit = vi.fn()
    render(<BodyEditor body={'<img src="x.png" alt="pic">'} editable isDark onCommit={onCommit} />)
    fireEvent.click(screen.getByTestId("task-body-read"))
    const textarea = await screen.findByTestId("task-body-raw-edit")
    fireEvent.change(textarea, { target: { value: "replaced entirely" } })
    fireEvent.keyDown(textarea, { key: "Escape" })
    expect(screen.queryByTestId("task-body-raw-edit")).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByTestId("task-body-read")).toBeTruthy()
  })

  it("blurring the editor after an edit commits plain markdown (heading grammar round-trips)", async () => {
    const { BodyEditor } = await import("../task-page/body-editor")
    const onCommit = vi.fn()
    const editorRef: { current: ReturnType<typeof Object> | null } = { current: null }
    render(
      <BodyEditor
        body="One paragraph."
        editable
        isDark
        onCommit={onCommit}
        editorRef={editorRef as never}
      />,
    )
    fireEvent.click(screen.getByTestId("task-body-read"))
    const prose = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".ProseMirror, [contenteditable=true]")
      if (!el || !editorRef.current) throw new Error("editor not mounted")
      return el
    })
    // jsdom can't type into ProseMirror — drive the same document change
    // through the command API, then blur to commit.
    ;(editorRef.current as { commands: { setContent: (c: string) => void } }).commands.setContent(
      "## Scope\n\nRewritten.",
    )
    fireEvent.blur(prose)
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    const markdown = onCommit.mock.calls[0][0] as string
    expect(markdown).toContain("## Scope")
    expect(markdown).toContain("Rewritten.")
  })
})
