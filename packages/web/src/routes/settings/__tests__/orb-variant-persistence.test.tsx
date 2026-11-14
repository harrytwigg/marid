import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS } from "@/lib/settings"
import { SettingsProvider, useSettings } from "@/routes/settings-provider"

vi.mock("@/hooks/use-onboarding", () => ({ useOnboarding: () => ({ data: undefined }) }))

type VariantContext = ReturnType<typeof useSettings> & {
  settings: ReturnType<typeof useSettings>["settings"] & { talkOrbVariant?: string }
  setTalkOrbVariant?: (variant: string) => void
}

function VariantProbe() {
  const context = useSettings() as VariantContext
  return (
    <button type="button" onClick={() => context.setTalkOrbVariant?.("pulse")}>
      {context.settings.talkOrbVariant ?? "missing"}
    </button>
  )
}

function mountProvider() {
  return render(
    <SettingsProvider>
      <VariantProbe />
    </SettingsProvider>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe("the persisted Talk orb variant setting", () => {
  it("has a named catalog default", async () => {
    mountProvider()

    expect(await screen.findByRole("button", { name: "mist" })).not.toBeNull()
    expect((DEFAULTS as unknown as { talkOrbVariant?: string }).talkOrbVariant).toBe("mist")
  })

  it("hydrates, changes, and reloads the selected variant", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ talkOrbVariant: "ring" }))
    const first = mountProvider()
    const picker = await screen.findByRole("button", { name: "ring" })

    fireEvent.click(picker)
    await waitFor(() => expect(picker.textContent).toBe("pulse"))
    expect(JSON.parse(localStorage.getItem("hundredfold-settings") ?? "{}").talkOrbVariant).toBe("pulse")

    first.unmount()
    mountProvider()
    expect(await screen.findByRole("button", { name: "pulse" })).not.toBeNull()
  })

  it("falls back to Mist when stored data names no shipped style", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ talkOrbVariant: "marble" }))

    mountProvider()

    expect(await screen.findByRole("button", { name: "mist" })).not.toBeNull()
  })
})
