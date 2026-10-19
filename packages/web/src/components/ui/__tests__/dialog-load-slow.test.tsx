import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Dialog, DialogContent, DialogTitle } from "../dialog"

/* The dialog's React Aria half loads when a dialog first opens. Here the chunk is held until the test lets it go. */

const gate = vi.hoisted(() => {
  let arrive: () => void = () => {}
  const promise = new Promise<void>((resolve) => { arrive = resolve })
  return { promise, arrive }
})

vi.mock("../dialog-popup", async (importOriginal) => {
  await gate.promise
  return importOriginal()
})

describe("a dialog whose popup is not loaded yet", () => {
  it("shows an inert scrim until the popup lands, then the dialog", async () => {
    // A render that suspends has to be inside an awaited act, or React is never told the chunk has landed.
    await act(async () => {
      render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Late</DialogTitle>
          </DialogContent>
        </Dialog>,
      )
    })

    const scrim = document.querySelector("[data-slot=dialog-loading]")
    expect(scrim?.className).toContain("pointer-events-none")
    expect(scrim?.querySelector("button, a, input, [tabindex]")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()

    await act(async () => {
      gate.arrive()
      await gate.promise
    })
    await screen.findByRole("dialog", { name: "Late" })
    expect(document.querySelector("[data-slot=dialog-loading]")).toBeNull()
  })
})
