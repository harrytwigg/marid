import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

const getAuthState = vi.fn()

vi.mock("@/lib/auth", () => ({
  getAuthState: (...args: unknown[]) => getAuthState(...args),
  bootstrapLocalAuth: vi.fn(),
  pairBrowser: vi.fn(),
  logoutBrowser: vi.fn(),
  createPairingCode: vi.fn(),
  listPairedDevices: vi.fn().mockResolvedValue([]),
  unpairDevice: vi.fn(),
  takeWorkspacePairingCode: vi.fn(),
  setRequestSource: vi.fn(),
}))

import { AuthGate, AuthProvider } from "../auth-provider"

const signedOut = { authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: false }

async function gate(extra: Record<string, unknown>) {
  getAuthState.mockResolvedValue({ ...signedOut, ...extra })
  render(
    <AuthProvider>
      <AuthGate><div>Private App</div></AuthGate>
    </AuthProvider>,
  )
  await screen.findByLabelText(/remote access code/i)
}

beforeEach(() => getAuthState.mockReset())

describe("AuthGate sign-in", () => {
  it("offers the email form when accounts are enabled and at least one exists", async () => {
    await gate({ accountsEnabled: true, hasAccounts: true })
    expect(screen.getByRole("form", { name: /sign in/i })).toBeTruthy()
  })

  it.each([
    ["accounts are not enabled", { accountsEnabled: false, hasAccounts: true }],
    ["no account exists yet", { accountsEnabled: true, hasAccounts: false }],
    ["the gateway predates accounts", {}],
    ["only accountsEnabled is reported", { accountsEnabled: true }],
  ])("shows only pairing when %s", async (_name, extra) => {
    await gate(extra)
    expect(screen.queryByRole("form", { name: /sign in/i })).toBeNull()
    expect(screen.getByRole("heading", { name: "Pair This Browser" })).toBeTruthy()
  })
})
