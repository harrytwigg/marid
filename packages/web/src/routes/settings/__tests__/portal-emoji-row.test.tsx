import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BRAND_MARK_SRC } from "@/lib/brand"
import { PortalEmojiRow } from "../emoji-rows"

const settings = { portalEmoji: null as string | null }
const setPortalEmoji = vi.fn()

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings, setPortalEmoji }) }))

beforeEach(() => {
  settings.portalEmoji = null
  setPortalEmoji.mockClear()
})

describe("PortalEmojiRow", () => {
  it("shows the glass mark while no emoji is set", () => {
    const { container } = render(<PortalEmojiRow />)
    expect(container.querySelector(`img[src="${BRAND_MARK_SRC}"]`)).toBeTruthy()
  })

  it("shows the operator's emoji instead of the mark", () => {
    settings.portalEmoji = "🦊"
    const { container } = render(<PortalEmojiRow />)
    expect(screen.getByLabelText("Choose portal emoji").textContent).toBe("🦊")
    expect(container.querySelector(`img[src="${BRAND_MARK_SRC}"]`)).toBeNull()
  })

  it("stores nothing for a blank field, so the swatch and the rail agree", () => {
    render(<PortalEmojiRow />)
    const field = screen.getByPlaceholderText("Default")
    fireEvent.change(field, { target: { value: " " } })
    fireEvent.blur(field)
    expect(setPortalEmoji).toHaveBeenCalledWith(null)
  })

  it("stores the trimmed glyph", () => {
    render(<PortalEmojiRow />)
    const field = screen.getByPlaceholderText("Default")
    fireEvent.change(field, { target: { value: " 🦊 " } })
    fireEvent.blur(field)
    expect(setPortalEmoji).toHaveBeenCalledWith("🦊")
  })

  it("shows the mark when a stored emoji is only whitespace", () => {
    settings.portalEmoji = " "
    const { container } = render(<PortalEmojiRow />)
    expect(container.querySelector(`img[src="${BRAND_MARK_SRC}"]`)).toBeTruthy()
  })
})
