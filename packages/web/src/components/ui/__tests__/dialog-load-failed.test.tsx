import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearNoticeSink, registerNoticeSink } from "@/lib/notices"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog"

/* The popup's chunk cannot be fetched (a stale chunk after a deploy, or offline). */

vi.mock("../dialog-popup", () => {
  throw new Error("Failed to fetch dynamically imported module")
})

afterEach(() => clearNoticeSink())

describe("a dialog whose popup cannot be fetched", () => {
  it("closes, says so on the notice surface, leaves nothing on screen, and the page stays usable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const onOpenChange = vi.fn()
    const notice = vi.fn()
    registerNoticeSink(notice)
    render(
      <Dialog onOpenChange={onOpenChange}>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Never</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    await act(async () => { await userEvent.click(screen.getByRole("button", { name: "Open" })) })

    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false))
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice).toHaveBeenCalledWith({ title: "The dialog couldn't load. Reload the page and try again.", level: "error" })
    expect(document.querySelector("[data-slot=dialog-loading]")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
