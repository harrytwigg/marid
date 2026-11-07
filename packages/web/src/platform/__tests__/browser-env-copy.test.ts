// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBrowserEnvironment } from "../adapters/web"

describe("browser environment legacy copy", () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = "" })

  it("copies the text through a scratch field and leaves the page as it was", () => {
    const seen: string[] = []
    document.execCommand = vi.fn((command: string) => {
      seen.push(`${command}:${(document.activeElement as HTMLTextAreaElement).value}`)
      return true
    })
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()

    expect(createBrowserEnvironment().copyLegacy?.("hello there")).toBe(true)
    expect(seen).toEqual(["copy:hello there"])
    expect(document.querySelector("textarea")).toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it("puts the scratch field inside an open dialog so it is not inert", () => {
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const button = document.createElement("button")
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    button.focus()
    let host: Element | null = null
    document.execCommand = vi.fn(() => {
      host = document.activeElement?.parentElement ?? null
      return true
    })

    createBrowserEnvironment().copyLegacy?.("x")
    expect(host).toBe(dialog)
  })

  it("reports a refused copy and still cleans up", () => {
    document.execCommand = vi.fn(() => false)
    expect(createBrowserEnvironment().copyLegacy?.("x")).toBe(false)
    expect(document.querySelector("textarea")).toBeNull()
  })
})
