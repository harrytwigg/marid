import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "../providers"

describe("the theme-color metas", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    localStorage.setItem("jinn-theme", "light")
    document.documentElement.style.setProperty("--bg", "#F6FAFE")
    document.head.innerHTML =
      '<meta name="theme-color" content="#111111" media="(prefers-color-scheme: light)">' +
      '<meta name="theme-color" content="#222222" media="(prefers-color-scheme: dark)">'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    document.documentElement.style.removeProperty("--bg")
    document.documentElement.removeAttribute("data-theme")
    document.head.innerHTML = ""
  })

  it("rewrites both per-scheme metas from the resolved --bg", () => {
    render(<ThemeProvider>{null}</ThemeProvider>)
    const contents = Array.from(document.querySelectorAll('meta[name="theme-color"]'), (m) => m.getAttribute("content"))
    expect(contents).toEqual(["#F6FAFE", "#F6FAFE"])
  })
})
