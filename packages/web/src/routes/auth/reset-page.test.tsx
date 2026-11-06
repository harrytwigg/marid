import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { installGatewayTransport, createBrowserGatewayTransport } from "@/lib/gateway-transport"

const inspectReset = vi.fn()
const completeReset = vi.fn()

vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api")
  return { ...actual, accountsApi: { ...actual.accountsApi, inspectReset: (...a: unknown[]) => inspectReset(...a), completeReset: (...a: unknown[]) => completeReset(...a) } }
})

import { AccountsError } from "@/lib/accounts-api"
import ResetPage from "./reset-page"

const navigate = vi.fn()
let restoreTransport: () => void
const GONE = "This link has expired or was already used"
const PASSWORD = "correct horse battery"

beforeEach(() => {
  inspectReset.mockReset()
  completeReset.mockReset()
  navigate.mockReset()
  restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
    origin: "http://gateway.test",
    request: async () => new Response("{}"),
    navigate,
  }))
  window.history.replaceState(null, "", "/reset#tok-987")
})

afterEach(() => {
  cleanup()
  restoreTransport()
  window.history.replaceState(null, "", "/")
})

async function renderReady() {
  inspectReset.mockResolvedValue({ email: "person@example.test" })
  render(<ResetPage />)
  await screen.findByRole("form", { name: /reset password/i })
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /set password/i }))
  })
}

describe("ResetPage", () => {
  it("clears the fragment before inspecting and names the account", async () => {
    const replace = vi.spyOn(window.history, "replaceState")
    await renderReady()
    expect(window.location.hash).toBe("")
    expect(replace).toHaveBeenCalled()
    expect(inspectReset).toHaveBeenCalledWith("tok-987")
    expect(screen.getByText("person@example.test")).toBeTruthy()
    replace.mockRestore()
  })

  it("blocks a short or mismatched password, then completes and lands on the app", async () => {
    await renderReady()
    type("Password", "short")
    type("Repeat password", "short")
    await save()
    expect(screen.getByRole("alert").textContent).toBe("Use at least 12 characters.")

    type("Password", PASSWORD)
    type("Repeat password", "another long password")
    await save()
    expect(screen.getByRole("alert").textContent).toBe("The two passwords don't match.")
    expect(completeReset).not.toHaveBeenCalled()

    type("Repeat password", PASSWORD)
    completeReset.mockResolvedValue({ ok: true })
    await save()
    expect(completeReset).toHaveBeenCalledWith("tok-987", PASSWORD)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("http://localhost:3000/"))
  })

  it("shows the expired-or-used sentence on a 410 from inspect, from completion, and for a missing token", async () => {
    inspectReset.mockRejectedValueOnce(new AccountsError(410, "used"))
    const first = render(<ResetPage />)
    expect((await screen.findByRole("alert")).textContent).toBe(GONE)
    first.unmount()

    window.history.replaceState(null, "", "/reset")
    render(<ResetPage />)
    expect((await screen.findByRole("alert")).textContent).toBe(GONE)
    cleanup()

    window.history.replaceState(null, "", "/reset#tok-987")
    await renderReady()
    type("Password", PASSWORD)
    type("Repeat password", PASSWORD)
    completeReset.mockRejectedValue(new AccountsError(410, "gone"))
    await save()
    expect((await screen.findByRole("alert")).textContent).toBe(GONE)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("shows the wait on a 429", async () => {
    await renderReady()
    type("Password", PASSWORD)
    type("Repeat password", PASSWORD)
    completeReset.mockRejectedValue(new AccountsError(429, "slow", 45))
    await save()
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 45 seconds.")
  })
})
