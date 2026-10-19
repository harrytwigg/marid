import "@/test/preload-menus"
import "@/test/preload-dialogs"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CronRow } from "../page"
import { CronDeleteMenu } from "../delete-menu"
import type { CronJobWire } from "../shared"

const deleteCronJob = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, deleteCronJob: (...args: unknown[]) => deleteCronJob(...args) } }
})

const NOW = new Date("2026-08-01T04:00:00.000Z")
const JOB: CronJobWire = { id: "nightly digest", name: "Nightly digest", schedule: "0 7 * * *", enabled: true }

function renderIn(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openDeleteConfirm() {
  await userEvent.click(await screen.findByLabelText("Actions for Nightly digest"))
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete job" }))
  return screen.findByRole("button", { name: "Delete" })
}

describe("CronDeleteMenu", () => {
  beforeEach(() => {
    deleteCronJob.mockReset()
    deleteCronJob.mockResolvedValue({ deleted: JOB.id, name: JOB.name })
  })

  it("deletes the job once, by id, when the confirm is accepted", async () => {
    const onDeleted = vi.fn()
    renderIn(<CronDeleteMenu job={JOB} variant="header" onDeleted={onDeleted} />)

    await userEvent.click(await openDeleteConfirm())

    expect(deleteCronJob.mock.calls).toEqual([[JOB.id]])
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it("names the job in the confirm so the wrong one cannot be deleted blind", async () => {
    renderIn(<CronDeleteMenu job={JOB} variant="header" />)
    await openDeleteConfirm()
    expect(screen.getByRole("heading", { name: "Delete “Nightly digest”?" })).toBeTruthy()
  })

  it("offers no dismiss control under the 34px a phone needs", async () => {
    renderIn(<CronDeleteMenu job={JOB} variant="row" />)
    await openDeleteConfirm()
    expect(document.querySelector("[data-slot='dialog-close']")).toBeNull()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()
  })

  it("sends nothing when the confirm is cancelled", async () => {
    renderIn(<CronDeleteMenu job={JOB} variant="row" />)
    await openDeleteConfirm()

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(deleteCronJob).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
  })

  it("keeps the row and reports a failed delete inline rather than swallowing it", async () => {
    const onDeleted = vi.fn()
    deleteCronJob.mockRejectedValue(new Error("Job is running"))
    renderIn(<CronDeleteMenu job={JOB} variant="row" onDeleted={onDeleted} />)

    await userEvent.click(await openDeleteConfirm())

    expect((await screen.findByRole("alert")).textContent).toContain("Job is running")
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe("CronRow", () => {
  const rowProps = { job: JOB, now: NOW, onToggle: vi.fn() }

  beforeEach(() => {
    deleteCronJob.mockReset()
    deleteCronJob.mockResolvedValue({ deleted: JOB.id, name: JOB.name })
  })

  it("does not open the job when the actions trigger is clicked", async () => {
    const onOpen = vi.fn()
    renderIn(<CronRow {...rowProps} onOpen={onOpen} />)

    await userEvent.click(screen.getByLabelText("Actions for Nightly digest"))

    expect(await screen.findByRole("menu")).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("does not open the job when the actions trigger is activated from the keyboard", async () => {
    const onOpen = vi.fn()
    renderIn(<CronRow {...rowProps} onOpen={onOpen} />)

    screen.getByLabelText("Actions for Nightly digest").focus()
    await userEvent.keyboard("{Enter}")

    expect(await screen.findByRole("menu")).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("does not open the job when the confirm is driven from a row", async () => {
    const onOpen = vi.fn()
    renderIn(<CronRow {...rowProps} onOpen={onOpen} />)

    await userEvent.click(await openDeleteConfirm())

    expect(deleteCronJob.mock.calls).toEqual([[JOB.id]])
    expect(onOpen).not.toHaveBeenCalled()
  })
})
