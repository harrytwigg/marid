import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// Stable references: a fresh object per render would re-trigger the composer's effects.
const orgData = { employees: [] }
const skillsData: unknown[] = []
const refetchSkills = vi.fn()

vi.mock("@/hooks/use-employees", () => ({
  useOrg: () => ({ data: orgData }),
}))

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: skillsData, refetch: refetchSkills }),
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: () => ({
    state: "idle",
    available: true,
    error: null,
    analyser: null,
    languages: ["en"],
    selectedLanguage: "en",
    downloadProgress: null,
    cycleLanguage: vi.fn(),
    handleMicClick: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(async () => null),
    cancelRecording: vi.fn(),
    startDownload: vi.fn(),
    dismissDownload: vi.fn(),
    dismissError: vi.fn(),
  }),
}))

import { ChatInput } from "../chat-input"

function renderInput(extra: { sessionStatusSlot?: React.ReactNode; onCardPointerDown?: () => void } = {}) {
  return render(
    <ChatInput
      disabled={false}
      loading={false}
      onSend={vi.fn()}
      onNewSession={vi.fn()}
      onStatusRequest={vi.fn()}
      events={[]}
      selectorSlot={<button type="button">model chip</button>}
      sessionStatusSlot={extra.sessionStatusSlot}
    />,
  )
}

describe("ChatInput session status slot", () => {
  it("renders nothing extra without a slot", () => {
    renderInput()
    expect(screen.queryByTestId("status-item")).toBeNull()
  })

  it("places the slot right after the model chip's wrapper", () => {
    renderInput({ sessionStatusSlot: <span data-testid="status-item">meter</span> })
    const chipWrapper = screen.getByRole("button", { name: "model chip" }).parentElement
    const slotWrapper = screen.getByTestId("status-item").parentElement
    expect(chipWrapper?.nextElementSibling).toBe(slotWrapper)
    // No box of its own: the slot's root decides whether anything takes room in the toolbar.
    expect(slotWrapper?.className).toBe("contents")
  })

  it("keeps a click on the slot from reaching the composer card's pointer handler", () => {
    const { container } = renderInput({ sessionStatusSlot: <button type="button">meter</button> })
    const reached = vi.fn()
    // The card sits above the toolbar; an event that gets past the slot wrapper reaches it.
    container.addEventListener("pointerdown", reached)
    fireEvent.pointerDown(screen.getByRole("button", { name: "meter" }))
    // React stops propagation at the wrapper, so the card handler never runs; the native
    // listener on the container still sees the DOM event.
    expect(reached).toHaveBeenCalledOnce()
    const wrapper = screen.getByRole("button", { name: "meter" }).parentElement!
    const event = new Event("pointerdown", { bubbles: true })
    const stop = vi.spyOn(event, "stopPropagation")
    wrapper.dispatchEvent(event)
    expect(stop).toHaveBeenCalled()
  })
})
