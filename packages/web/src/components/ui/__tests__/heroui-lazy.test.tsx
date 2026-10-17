import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createLazyHeroUI } from "../heroui-lazy"

function Probe({ lazy }: { lazy: { use: () => { name: string } | undefined } }) {
  const loaded = lazy.use()
  return <p data-testid="probe">{loaded ? loaded.name : "plain"}</p>
}

describe("createLazyHeroUI", () => {
  it("draws the stand-in until the module arrives, then the module, loading it once", async () => {
    let resolve!: (module: { name: string }) => void
    const load = vi.fn(() => new Promise<{ name: string }>((r) => (resolve = r)))
    const lazy = createLazyHeroUI(load)
    render(
      <>
        <Probe lazy={lazy} />
        <Probe lazy={lazy} />
      </>,
    )
    expect(screen.getAllByTestId("probe").map((n) => n.textContent)).toEqual(["plain", "plain"])

    void lazy.preload()
    void lazy.preload()
    await act(async () => {
      resolve({ name: "loaded" })
      await lazy.preload()
    })

    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId("probe").map((n) => n.textContent)).toEqual(["loaded", "loaded"])
  })

  it("loads on its own when a control is mounted, once the browser is idle", async () => {
    vi.useFakeTimers()
    try {
      const load = vi.fn(() => Promise.resolve({ name: "loaded" }))
      const lazy = createLazyHeroUI(load)
      render(<Probe lazy={lazy} />)
      expect(load).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(load).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("probe").textContent).toBe("loaded")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the stand-in when the chunk fails to load, and tries again on the next mount", async () => {
    vi.useFakeTimers()
    try {
      const load = vi
        .fn<() => Promise<{ name: string }>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ name: "loaded" })
      const lazy = createLazyHeroUI(load)
      const first = render(<Probe lazy={lazy} />)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(screen.getByTestId("probe").textContent).toBe("plain")
      first.unmount()

      render(<Probe lazy={lazy} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(load).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId("probe").textContent).toBe("loaded")
    } finally {
      vi.useRealTimers()
    }
  })
})
