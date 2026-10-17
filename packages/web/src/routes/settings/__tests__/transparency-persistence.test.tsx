import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS, loadSettings } from "@/lib/settings"
import { SettingsProvider, useSettings } from "@/routes/settings-provider"
import { TransparencyPicker } from "@/routes/settings/appearance-pickers"

vi.mock("@/hooks/use-onboarding", () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark", setTheme: () => {} }) }))

function Probe() {
  const { settings } = useSettings()
  return <output data-testid="value">{settings.transparency}</output>
}

function mountProvider() {
  return render(
    <SettingsProvider>
      <Probe />
      <TransparencyPicker />
    </SettingsProvider>,
  )
}

const root = document.documentElement

beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  root.removeAttribute("data-transparency")
})

describe("the persisted transparency setting", () => {
  it("defaults to full and leaves the root unmarked", async () => {
    mountProvider()

    expect(DEFAULTS.transparency).toBe("full")
    expect((await screen.findByTestId("value")).textContent).toBe("full")
    expect(root.hasAttribute("data-transparency")).toBe(false)
  })

  it("switches the root attribute on and off from the picker", async () => {
    mountProvider()

    fireEvent.click(screen.getByRole("button", { name: "Reduced" }))
    await waitFor(() => expect(root.getAttribute("data-transparency")).toBe("reduced"))
    expect(screen.getByRole("button", { name: "Reduced" }).getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "Full" }))
    await waitFor(() => expect(root.hasAttribute("data-transparency")).toBe(false))
  })

  it("persists the choice and restores it on the next mount", async () => {
    const first = mountProvider()
    fireEvent.click(screen.getByRole("button", { name: "Reduced" }))
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("jinn-settings") ?? "{}").transparency).toBe("reduced"),
    )

    first.unmount()
    root.removeAttribute("data-transparency")
    mountProvider()

    expect((await screen.findByTestId("value")).textContent).toBe("reduced")
    await waitFor(() => expect(root.getAttribute("data-transparency")).toBe("reduced"))
  })

  it("falls back to full when the stored value is junk", () => {
    for (const stored of ["clear", 1, null, undefined]) {
      localStorage.setItem("jinn-settings", JSON.stringify({ transparency: stored }))
      expect(loadSettings().transparency).toBe("full")
    }
  })
})

describe("the blocking bootstrap in index.html", () => {
  const html = readFileSync(resolve(__dirname, "../../../../index.html"), "utf8")
  const script = /<script>(\(function\(\)\{try\{var t=localStorage[\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""

  afterEach(() => {
    root.removeAttribute("data-theme")
    root.style.removeProperty("--text-scale")
  })

  it("marks the root before React mounts when the stored choice is reduced", () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ transparency: "reduced", textScale: 1.1 }))

    new Function(script)()

    expect(root.getAttribute("data-transparency")).toBe("reduced")
    expect(root.style.getPropertyValue("--text-scale")).toBe("1.1")
  })

  it("leaves the root unmarked for full, junk or nothing stored", () => {
    expect(script).not.toBe("")
    for (const stored of [{ transparency: "full" }, { transparency: "clear" }, {}]) {
      localStorage.setItem("jinn-settings", JSON.stringify(stored))
      new Function(script)()
      expect(root.hasAttribute("data-transparency")).toBe(false)
    }
  })
})
