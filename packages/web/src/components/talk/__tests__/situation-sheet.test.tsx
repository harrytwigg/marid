import { readFileSync } from "node:fs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closePreview } from "../media-preview-store"
import { SituationSheet } from "../situation-sheet"
import type { Situation, SituationPayload } from "../situation-payload"
import { KINDS, PAYLOADS } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({
  api: {
    getWorkItem: vi.fn(async () => ({ workItem: { id: "AAA-1", title: "A Todo", status: "assigned", assignee: "a-lead" } })),
    getSession: vi.fn(async () => ({ title: "A session" })),
  },
}))

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

function situation(kind: SituationPayload["kind"]): Situation {
  return { id: `s-${kind}`, title: "A decision", hint: "Pick one", payload: PAYLOADS[kind] }
}

function renderSheet(value: Situation | null, onAnswer = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <QueryClientProvider client={client}>
      <SituationSheet situation={value} onAnswer={onAnswer} onDismiss={vi.fn()} />
    </QueryClientProvider>,
  )
  return { ...result, onAnswer }
}

beforeEach(() => {
  stubReducedMotion(false)
})

// The preview is held outside React, so unmounting the sheet does not close it.
afterEach(() => {
  closePreview()
})

describe("SituationSheet body", () => {
  it("draws all five kinds through the registry, with no kind of its own", () => {
    for (const kind of KINDS) {
      const { unmount } = renderSheet(situation(kind))
      expect(document.querySelector(`[data-situation-renderer="${kind}"]`)).not.toBeNull()
      unmount()
    }
  })

  it("names no individual kind in its source", () => {
    // Vitest runs from the package root, so this is the file the sheet ships as.
    const source = readFileSync("src/components/talk/situation-sheet.tsx", "utf8")
    for (const kind of KINDS) {
      expect(source).not.toContain(kind)
    }
  })

  it("shows the situation's own title and hint", () => {
    renderSheet(situation("options"))
    expect(screen.getByRole("dialog", { name: "A decision" })).toBeTruthy()
    expect(screen.getByText("Pick one")).toBeTruthy()
  })
})

describe("answering", () => {
  it("answers on a click, with that card's id", async () => {
    const { onAnswer } = renderSheet(situation("options"))
    await userEvent.click(screen.getByRole("button", { name: /Ship it/ }))
    expect(onAnswer).toHaveBeenCalledWith("ship")
  })

  it("answers on Enter and on Space", async () => {
    const { onAnswer } = renderSheet(situation("options"))
    const card = screen.getByRole("button", { name: /Revise/ })
    card.focus()
    await userEvent.keyboard("{Enter}")
    await userEvent.keyboard(" ")
    expect(onAnswer).toHaveBeenCalledTimes(2)
    expect(onAnswer).toHaveBeenNthCalledWith(1, "revise")
    expect(onAnswer).toHaveBeenNthCalledWith(2, "revise")
  })

  // ICI-755 superseded the tile as an answering card: a tap opens the preview,
  // and the answer moved onto the preview's own control.
  it("answers image and clip sets from the preview a tile opens", async () => {
    const images = renderSheet(situation("images"))
    await userEvent.click(screen.getByRole("button", { name: /Variant B/ }))
    expect(images.onAnswer).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Pick this" }))
    expect(images.onAnswer).toHaveBeenCalledWith("variant-b")
    images.unmount()

    const clips = renderSheet(situation("video"))
    await userEvent.click(screen.getByRole("button", { name: /Fast cut/ }))
    await userEvent.click(screen.getByRole("button", { name: "Pick this" }))
    expect(clips.onAnswer).toHaveBeenCalledWith("cut-fast")
  })

  it("renders no confirm, OK or submit control for any kind", () => {
    for (const kind of KINDS) {
      const { unmount } = renderSheet(situation(kind))
      const named = screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "")
      expect(named.some((name) => /confirm|\bok\b|submit|done|apply/i.test(name))).toBe(false)
      unmount()
    }
  })
})

describe("reduced motion", () => {
  it("resolves the sheet in one frame, with no transition to run", () => {
    stubReducedMotion(true)
    renderSheet(situation("prose"))
    const sheet = document.querySelector<HTMLElement>("[data-situation-sheet]")!
    expect(sheet.style.transitionDuration).toBe("0ms")
    expect(sheet.style.transform).toBe("")
    expect(document.querySelector("[data-situation-phase]")?.getAttribute("data-situation-phase")).toBe("open")
  })

  it("runs the 280ms entrance when motion is allowed", () => {
    renderSheet(situation("prose"))
    const sheet = document.querySelector<HTMLElement>("[data-situation-sheet]")!
    expect(sheet.style.transitionDuration).toBe("280ms")
    expect(sheet.style.transform).toBe("scale(0.6)")
  })

  it("settles at full size instead of sitting shrunken and invisible", async () => {
    renderSheet(situation("prose"))
    const sheet = document.querySelector<HTMLElement>("[data-situation-sheet]")!

    await waitFor(() => {
      expect(document.querySelector("[data-situation-phase]")?.getAttribute("data-situation-phase")).toBe("open")
    })
    expect(sheet.style.transform).toBe("")
    expect(sheet.className).toContain("opacity-100")
  })
})
