import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DepartmentRowWire } from "@/lib/department-api"
import { BoardSwitcher } from "../board/board-switcher"
import { DepartmentArchiveMenu } from "../board/department-archive-menu"
import { creatableDepartment, offeredDepartments } from "../pickers/department-filters"

/* Archived departments: out of every department list until asked for, never
 * offered to file a Todo into, and archived only through a dialog that asks
 * again when the gateway says the department still has people or open work. */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { listWorkItems: vi.fn(async () => ({ workItems: [], totals: {} })) } }
})

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

afterEach(() => authFetch.mockReset())

const rows: DepartmentRowWire[] = [
  { slug: "engineering", prefix: "ENG", createdAt: "2026-07-01", todoCount: 3, selectable: true, archived: false },
  { slug: "old-catchall", prefix: "OLD", createdAt: "2026-07-01", todoCount: 40, selectable: false, archived: true, archivedAt: "2026-10-07T00:00:00.000Z" },
]

function withClient(node: React.ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/todos/b/everything"]}>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

async function openSwitcher(board: Parameters<typeof BoardSwitcher>[0]["board"] = { kind: "everything" }) {
  render(withClient(<BoardSwitcher board={board} title="Everything" departments={rows} attentionCount={0} />))
  const trigger = await screen.findByTestId("board-switcher")
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getByTestId("board-menu-attention")).toBeTruthy())
}

describe("the board switcher", () => {
  it("leaves an archived department out until Show archived reveals it", async () => {
    await openSwitcher()
    expect(screen.getByTestId("board-menu-engineering")).toBeTruthy()
    expect(screen.queryByTestId("board-menu-old-catchall")).toBeNull()

    fireEvent.click(screen.getByTestId("board-menu-show-archived"))
    const revealed = await screen.findByTestId("board-menu-old-catchall")
    expect(within(revealed).getByTestId("department-archived-tag")).toBeTruthy()
    expect(screen.getByTestId("board-menu-show-archived").textContent).toContain("Hide archived")
  })

  it("lists an archived department while its own board is open", async () => {
    await openSwitcher({ kind: "department", slug: "old-catchall" })
    expect(screen.getByTestId("board-menu-old-catchall")).toBeTruthy()
  })
})

describe("the department filters", () => {
  it("never offer an archived department to file into, except the one a Todo already sits in", () => {
    expect(offeredDepartments(rows, null).map((d) => d.slug)).toEqual(["engineering"])
    expect(offeredDepartments(rows, "old-catchall").map((d) => d.slug)).toEqual(["engineering", "old-catchall"])
  })

  it("start a new Todo from an archived board in no department", () => {
    expect(creatableDepartment(rows, "old-catchall")).toBeNull()
  })

  it("do not read an archive as a closed policy: an unregistered slug still seeds a new Todo", () => {
    expect(creatableDepartment(rows, "brand-new")).toBe("brand-new")
  })
})

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const archivedDefinition = { slug: "engineering", prefix: "ENG", archived: true }

async function openArchiveDialog(archived = false) {
  render(withClient(<DepartmentArchiveMenu slug="engineering" prefix="ENG" archived={archived} />))
  const trigger = screen.getByTestId("department-board-menu")
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByTestId(archived ? "department-unarchive" : "department-archive"))
  return screen.findByTestId("department-archive-submit")
}

describe("the archive dialog", () => {
  it("asks again, naming who and what is left, before it sends confirm", async () => {
    authFetch
      .mockResolvedValueOnce(respond(409, { error: "engineering still has…", code: "department-archive-confirm", members: ["dev-one"], openTodos: 2 }))
      .mockResolvedValueOnce(respond(200, { department: archivedDefinition }))
    const submit = await openArchiveDialog()
    fireEvent.click(submit)

    const notice = await screen.findByTestId("department-archive-confirm")
    expect(notice.textContent).toContain("1 member (dev-one)")
    expect(notice.textContent).toContain("2 open Todos")
    expect(JSON.parse(authFetch.mock.calls[0]![1].body)).toEqual({})

    fireEvent.click(screen.getByTestId("department-archive-submit"))
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2))
    expect(authFetch.mock.calls[1]![0]).toBe("/api/departments/engineering/archive")
    expect(JSON.parse(authFetch.mock.calls[1]![1].body)).toEqual({ confirm: true })
    await waitFor(() => expect(screen.queryByTestId("department-archive-submit")).toBeNull())
  })

  it("shows any other refusal as an error and does not offer to force it", async () => {
    authFetch.mockResolvedValueOnce(respond(409, { error: "engineering is gateway.todoDepartments.default", code: "department-default" }))
    fireEvent.click(await openArchiveDialog())
    expect((await screen.findByTestId("department-archive-error")).textContent).toContain("todoDepartments.default")
    expect(screen.queryByTestId("department-archive-confirm")).toBeNull()
    expect(screen.getByTestId("department-archive-submit").textContent).toBe("Archive")
  })

  it("un-archives in one step", async () => {
    authFetch.mockResolvedValueOnce(respond(200, { department: { ...archivedDefinition, archived: false } }))
    fireEvent.click(await openArchiveDialog(true))
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    expect(authFetch.mock.calls[0]![0]).toBe("/api/departments/engineering/unarchive")
  })
})
