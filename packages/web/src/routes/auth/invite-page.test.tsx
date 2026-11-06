import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { installGatewayTransport, createBrowserGatewayTransport } from "@/lib/gateway-transport"

const inspectInvite = vi.fn()
const acceptInvite = vi.fn()

vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api")
  return { ...actual, accountsApi: { ...actual.accountsApi, inspectInvite: (...a: unknown[]) => inspectInvite(...a), acceptInvite: (...a: unknown[]) => acceptInvite(...a) } }
})

import { AccountsError } from "@/lib/accounts-api"
import InvitePage from "./invite-page"

const navigate = vi.fn()
let restoreTransport: () => void

const GONE = "This link has expired or was already used"
const PASSWORD = "correct horse battery"

beforeEach(() => {
  inspectInvite.mockReset()
  acceptInvite.mockReset()
  navigate.mockReset()
  restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
    origin: "http://gateway.test",
    request: async () => new Response("{}"),
    navigate,
  }))
  window.history.replaceState(null, "", "/invite#tok-123")
})

afterEach(() => {
  cleanup()
  restoreTransport()
  vi.useRealTimers()
  window.history.replaceState(null, "", "/")
})

async function renderReady(info: Record<string, unknown> = { email: "new@example.test", boardName: "Design", role: "collaborator", invitedBy: "Alex" }) {
  inspectInvite.mockResolvedValue(info)
  render(<InvitePage />)
  await screen.findByRole("form", { name: /accept invite/i })
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function create() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }))
  })
}

describe("InvitePage", () => {
  it("takes the token out of the address bar before the inspect call resolves", async () => {
    const replace = vi.spyOn(window.history, "replaceState")
    let release!: (value: unknown) => void
    inspectInvite.mockReturnValue(new Promise((resolve) => { release = resolve }))
    render(<InvitePage />)

    expect(window.location.hash).toBe("")
    expect(replace).toHaveBeenCalled()
    expect(inspectInvite).toHaveBeenCalledTimes(1)
    expect(inspectInvite).toHaveBeenCalledWith("tok-123")
    release({ email: "new@example.test" })
    await screen.findByRole("form", { name: /accept invite/i })
    expect(inspectInvite).toHaveBeenCalledTimes(1)
    replace.mockRestore()
  })

  it("says who invited them, to which board and as what", async () => {
    await renderReady()
    expect(screen.getByRole("heading", { name: "You're invited to Design" })).toBeTruthy()
    expect(screen.getByText("Invited by Alex")).toBeTruthy()
    expect(screen.getByText("Collaborator")).toBeTruthy()
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("new@example.test")
  })

  it("reads as an invitation to the product when the invite names no board", async () => {
    await renderReady({ email: "new@example.test" })
    expect(screen.getByRole("heading", { name: /^You're invited to \S+/ }).textContent).not.toMatch(/Design/)
    expect(screen.queryByText(/You'll join as/)).toBeNull()
  })

  it("blocks a name left empty, a short password and mismatched passwords, then accepts a valid form", async () => {
    await renderReady()

    await create()
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your name.")

    type("Your name", "  New Person ")
    type("Password", "short")
    type("Repeat password", "short")
    await create()
    expect(screen.getByRole("alert").textContent).toBe("Use at least 12 characters.")

    type("Password", PASSWORD)
    type("Repeat password", PASSWORD + "x")
    await create()
    expect(screen.getByRole("alert").textContent).toBe("The two passwords don't match.")
    expect(acceptInvite).not.toHaveBeenCalled()

    type("Repeat password", PASSWORD)
    acceptInvite.mockResolvedValue({ ok: true })
    await create()
    expect(acceptInvite).toHaveBeenCalledWith("tok-123", "New Person", PASSWORD)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("http://localhost:3000/"))
  })

  it("shows the one expired-or-used sentence when the inspect says 410", async () => {
    inspectInvite.mockRejectedValue(new AccountsError(410, "Invite already used"))
    render(<InvitePage />)
    expect((await screen.findByRole("alert")).textContent).toBe(GONE)
  })

  it("shows it for a missing token without asking the gateway", async () => {
    window.history.replaceState(null, "", "/invite")
    render(<InvitePage />)
    expect((await screen.findByRole("alert")).textContent).toBe(GONE)
    expect(inspectInvite).not.toHaveBeenCalled()
  })

  it("shows it when accepting says 410, and stays on the form", async () => {
    await renderReady()
    type("Your name", "New Person")
    type("Password", PASSWORD)
    type("Repeat password", PASSWORD)
    acceptInvite.mockRejectedValue(new AccountsError(410, "gone"))
    await create()
    expect((await screen.findByRole("alert")).textContent).toBe(GONE)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("shows the wait on a 429 and the server's words on anything else", async () => {
    await renderReady()
    type("Your name", "New Person")
    type("Password", PASSWORD)
    type("Repeat password", PASSWORD)
    acceptInvite.mockRejectedValueOnce(new AccountsError(429, "slow", 120))
    await create()
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 2 minutes.")
    acceptInvite.mockRejectedValueOnce(new AccountsError(500, "The gateway is busy"))
    await create()
    expect((await screen.findByRole("alert")).textContent).toBe("The gateway is busy")
  })

  it("waits out a 429 on inspect before letting the person try again", async () => {
    vi.useFakeTimers()
    inspectInvite.mockRejectedValueOnce(new AccountsError(429, "slow", 2)).mockResolvedValue({ email: "new@example.test" })
    render(<InvitePage />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 2 seconds.")
    const retry = screen.getByRole("button", { name: /try again/i }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(retry.disabled).toBe(false)
    await act(async () => { fireEvent.click(retry) })
    expect(screen.getByRole("form", { name: /accept invite/i })).toBeTruthy()
  })
})
