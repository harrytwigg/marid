import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const getAuthState = vi.fn()
const bootstrapLocalAuth = vi.fn()
const pairBrowser = vi.fn()
const logoutBrowser = vi.fn()
const createPairingCode = vi.fn()
const listPairedDevices = vi.fn()
const unpairDevice = vi.fn()
const takeWorkspacePairingCode = vi.fn()

vi.mock("@/lib/auth", () => ({
  getAuthState: (...args: unknown[]) => getAuthState(...args),
  bootstrapLocalAuth: (...args: unknown[]) => bootstrapLocalAuth(...args),
  pairBrowser: (...args: unknown[]) => pairBrowser(...args),
  logoutBrowser: (...args: unknown[]) => logoutBrowser(...args),
  createPairingCode: (...args: unknown[]) => createPairingCode(...args),
  listPairedDevices: (...args: unknown[]) => listPairedDevices(...args),
  unpairDevice: (...args: unknown[]) => unpairDevice(...args),
  takeWorkspacePairingCode: (...args: unknown[]) => takeWorkspacePairingCode(...args),
  setRequestSource: vi.fn(),
  setMemberSessionLostHandler: vi.fn(),
  reportMemberSessionLost: vi.fn(),
}))

import { useEffect, useRef } from "react"
import { AuthGate, AuthProvider, useAuth } from "./auth-provider"

beforeEach(() => {
  getAuthState.mockReset()
  bootstrapLocalAuth.mockReset()
  pairBrowser.mockReset()
  logoutBrowser.mockReset()
  createPairingCode.mockReset()
  listPairedDevices.mockReset()
  unpairDevice.mockReset()
  takeWorkspacePairingCode.mockReset()
  listPairedDevices.mockResolvedValue([])
  unpairDevice.mockResolvedValue(undefined)
})

describe("AuthProvider/AuthGate", () => {
  it("renders the app immediately when auth is not required", async () => {
    getAuthState.mockResolvedValue({ authRequired: false, authenticated: true })
    takeWorkspacePairingCode.mockReturnValueOnce("UNNEEDED-CODE")

    render(
      <AuthProvider>
        <AuthGate>
          <div>Private App</div>
        </AuthGate>
      </AuthProvider>,
    )

    expect(await screen.findByText("Private App")).toBeTruthy()
    expect(takeWorkspacePairingCode).toHaveBeenCalledTimes(1)
    expect(pairBrowser).not.toHaveBeenCalled()
  })

  it("silently bootstraps a local browser before rendering the app", async () => {
    getAuthState
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: true,
        networkExposed: false,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: true,
        canBootstrapLocal: true,
        networkExposed: false,
      })
    bootstrapLocalAuth.mockResolvedValue(true)

    render(
      <AuthProvider>
        <AuthGate>
          <div>Private App</div>
        </AuthGate>
      </AuthProvider>,
    )

    await waitFor(() => expect(bootstrapLocalAuth).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("Private App")).toBeTruthy()
  })

  it("silently exchanges a one-time workspace pairing fragment before showing remote onboarding", async () => {
    getAuthState
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: false,
        networkExposed: true,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: true,
        canBootstrapLocal: false,
        networkExposed: true,
      })
    takeWorkspacePairingCode.mockReturnValueOnce("ABCD-EFGH-JKLM")
    pairBrowser.mockResolvedValue(undefined)

    render(
      <AuthProvider>
        <AuthGate>
          <div>New workspace onboarding</div>
        </AuthGate>
      </AuthProvider>,
    )

    await waitFor(() => expect(pairBrowser).toHaveBeenCalledWith("ABCD-EFGH-JKLM", "code"))
    expect(await screen.findByText("New workspace onboarding")).toBeTruthy()
  })

  it("shows the pairing screen instead of children for unpaired remote browsers", async () => {
    getAuthState.mockResolvedValue({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    })

    render(
      <AuthProvider>
        <AuthGate>
          <div>Private App</div>
        </AuthGate>
      </AuthProvider>,
    )

    expect(await screen.findByText(/Pair This Browser/i)).toBeTruthy()
    expect(screen.queryByText("Private App")).toBeNull()
  })

  it("exposes shared unpair behavior and refreshes the device list", async () => {
    getAuthState.mockResolvedValue({
      authRequired: true,
      authenticated: true,
      canBootstrapLocal: false,
      networkExposed: true,
    })
    listPairedDevices
      .mockResolvedValueOnce([{ id: "device-1", name: "iPhone browser", current: false }])
      .mockResolvedValueOnce([])

    function DeviceControls() {
      const auth = useAuth()
      return (
        <button type="button" onClick={() => { void auth.unpairDevice("device-1") }}>
          Unpair from context
        </button>
      )
    }

    render(
      <AuthProvider>
        <AuthGate>
          <DeviceControls />
        </AuthGate>
      </AuthProvider>,
    )

    fireEvent.click(await screen.findByRole("button", { name: /unpair from context/i }))

    await waitFor(() => expect(unpairDevice).toHaveBeenCalledWith("device-1"))
    await waitFor(() => expect(listPairedDevices).toHaveBeenCalledTimes(2))
  })

  it("does not immediately re-bootstrap after explicitly forgetting a local browser", async () => {
    getAuthState
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: true,
        canBootstrapLocal: true,
        networkExposed: true,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: true,
        networkExposed: true,
      })
    logoutBrowser.mockResolvedValue(undefined)

    function LogoutButton() {
      const auth = useAuth()
      return (
        <button type="button" onClick={() => { void auth.logout() }}>
          Forget local browser
        </button>
      )
    }

    render(
      <AuthProvider>
        <AuthGate>
          <LogoutButton />
        </AuthGate>
      </AuthProvider>,
    )

    fireEvent.click(await screen.findByRole("button", { name: /forget local browser/i }))

    await waitFor(() => expect(logoutBrowser).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/Pair This Browser/i)).toBeTruthy())
    expect(bootstrapLocalAuth).not.toHaveBeenCalled()
  })

  it("keeps the pairing gate visible if post-pair auth state is still unauthenticated", async () => {
    getAuthState
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: false,
        networkExposed: true,
      })
      .mockResolvedValueOnce({
        authRequired: true,
        authenticated: false,
        canBootstrapLocal: false,
        networkExposed: true,
      })
    pairBrowser.mockResolvedValue(undefined)

    render(
      <AuthProvider>
        <AuthGate>
          <div>Private App</div>
        </AuthGate>
      </AuthProvider>,
    )

    const input = await screen.findByLabelText(/remote access code/i)
    fireEvent.change(input, { target: { value: "ABCD-EFGH-JKLM" } })
    fireEvent.click(screen.getByRole("button", { name: /pair browser/i }))

    await waitFor(() => expect(pairBrowser).toHaveBeenCalledWith("ABCD-EFGH-JKLM", "code"))
    expect(await screen.findByText(/Pair This Browser/i)).toBeTruthy()
    expect(screen.queryByText("Private App")).toBeNull()
  })
})

it("does not mistake an unreachable gateway for an unpaired browser", async () => {
  getAuthState.mockRejectedValue(new TypeError("Failed to fetch"))
  render(<AuthProvider><AuthGate><div>Private App</div></AuthGate></AuthProvider>)
  expect(await screen.findByRole('heading', { name: 'This page could not load' })).toBeTruthy()
  expect(screen.queryByText(/Pair This Browser/i)).toBeNull()
  expect(screen.queryByText('Private App')).toBeNull()
  expect(pairBrowser).not.toHaveBeenCalled()

})

describe("reread", () => {
    // Counts its own mounts: a remount behind the "checking" screen would mount it again.
    function Probe({ mounts }: { mounts: { n: number } }) {
      const { reread, principal } = useAuth()
      const counted = useRef(false)
      useEffect(() => { if (!counted.current) { counted.current = true; mounts.n++ } }, [mounts])
      return (
        <div>
          <span data-testid="who">{principal?.kind === "operator" ? principal.user?.displayName ?? "operator" : "none"}</span>
          <button type="button" onClick={() => void reread()}>reread</button>
        </div>
      )
    }
    const operator = { authRequired: true, authenticated: true, hasAccounts: false, principal: { kind: "operator" } }

    it("updates who this browser is in place, without the checking screen or a remount", async () => {
      getAuthState.mockResolvedValueOnce(operator)
      const mounts = { n: 0 }
      render(<AuthProvider><AuthGate><Probe mounts={mounts} /></AuthGate></AuthProvider>)
      expect((await screen.findByTestId("who")).textContent).toBe("operator")
      let release!: (value: unknown) => void
      getAuthState.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
      fireEvent.click(screen.getByText("reread"))
      // While the read is in flight the app stays up.
      expect(screen.queryByText(/checking gateway access/i)).toBeNull()
      expect(screen.getByTestId("who")).toBeTruthy()
      release({ ...operator, hasAccounts: true, principal: { kind: "operator", user: { id: "usr_1", displayName: "Olive Owner" } } })
      await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("Olive Owner"))
      expect(mounts.n).toBe(1)
    })

    it("keeps the app and the current reading when the read fails", async () => {
      getAuthState.mockResolvedValueOnce(operator)
      const mounts = { n: 0 }
      render(<AuthProvider><AuthGate><Probe mounts={mounts} /></AuthGate></AuthProvider>)
      await screen.findByTestId("who")
      getAuthState.mockRejectedValueOnce(new Error("gateway unreachable"))
      fireEvent.click(screen.getByText("reread"))
      await waitFor(() => expect(getAuthState).toHaveBeenCalledTimes(2))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.getByTestId("who").textContent).toBe("operator")
      expect(screen.queryByText(/gateway unreachable/i)).toBeNull()
      expect(mounts.n).toBe(1)
    })
  })
