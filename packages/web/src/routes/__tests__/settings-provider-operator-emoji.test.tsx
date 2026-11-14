import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const useOnboarding = vi.fn()

vi.mock("@/hooks/use-onboarding", () => ({
  useOnboarding: () => useOnboarding(),
}))

import { SettingsProvider, useSettings } from "../settings-provider"

function OperatorEmoji() {
  const { settings } = useSettings()
  return <span data-testid="operator-emoji">{settings.operatorEmoji ?? "none"}</span>
}

beforeEach(() => {
  localStorage.clear()
  useOnboarding.mockReset()
})

describe("SettingsProvider operator emoji", () => {
  it("prefers the configured emoji over a stale localStorage value", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ operatorEmoji: "🐼" }))
    useOnboarding.mockReturnValue({ data: { operatorEmoji: "🦊" } })

    render(
      <SettingsProvider>
        <OperatorEmoji />
      </SettingsProvider>,
    )

    await waitFor(() => expect(screen.getByTestId("operator-emoji").textContent).toBe("🦊"))
    expect(JSON.parse(localStorage.getItem("hundredfold-settings")!).operatorEmoji).toBe("🦊")
  })

  it("clears a stale stored emoji when the backend reports none", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ operatorEmoji: "🐼" }))
    useOnboarding.mockReturnValue({ data: { operatorEmoji: null, operatorName: "Operator" } })

    render(
      <SettingsProvider>
        <OperatorEmoji />
      </SettingsProvider>,
    )

    await waitFor(() => expect(screen.getByTestId("operator-emoji").textContent).toBe("none"))
    expect(JSON.parse(localStorage.getItem("hundredfold-settings")!).operatorEmoji).toBeNull()
  })

  it("leaves the stored emoji alone until the onboarding query resolves", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ operatorEmoji: "🐼" }))
    useOnboarding.mockReturnValue({ data: undefined })

    render(
      <SettingsProvider>
        <OperatorEmoji />
      </SettingsProvider>,
    )

    await waitFor(() => expect(screen.getByTestId("operator-emoji").textContent).toBe("🐼"))
  })
})
