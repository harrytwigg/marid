import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { IssuedLink } from "../issued-link"

describe("IssuedLink", () => {
  it("holds the link in a copy box until dismissed", () => {
    const onDismiss = vi.fn()
    render(<IssuedLink link="https://x.test/invite#abc" expiresAt="2026-11-13T10:00:00Z" onDismiss={onDismiss} />)
    expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe("https://x.test/invite#abc")
    fireEvent.click(screen.getByTestId("issued-link-dismiss"))
    expect(onDismiss).toHaveBeenCalled()
  })

  it("says the link could not be built, with no empty copy box, when the gateway sent none", () => {
    const onDismiss = vi.fn()
    render(<IssuedLink link={null} onDismiss={onDismiss} />)
    expect(screen.getByRole("alert").textContent).toMatch(/couldn.t build the link; open this page from the address people will use/i)
    expect(screen.queryByLabelText("Link")).toBeNull()
    expect(screen.queryByTestId("issued-link-copy")).toBeNull()
    fireEvent.click(screen.getByTestId("issued-link-dismiss"))
    expect(onDismiss).toHaveBeenCalled()
  })
})
