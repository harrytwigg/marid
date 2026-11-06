import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"

/** One tab, one query client, two people one after the other: the first person's cached boards and Todos must
 *  not be there for the second, however the switch happens. */
const getAuthState = vi.fn()
vi.mock("@/lib/auth", () => ({
  getAuthState: (...a: unknown[]) => getAuthState(...a),
  bootstrapLocalAuth: vi.fn(),
  pairBrowser: vi.fn(),
  logoutBrowser: vi.fn(),
  createPairingCode: vi.fn(),
  listPairedDevices: vi.fn().mockResolvedValue([]),
  unpairDevice: vi.fn(),
  takeWorkspacePairingCode: vi.fn(),
  setRequestSource: vi.fn(),
  setMemberSessionLostHandler: vi.fn(),
  reportMemberSessionLost: vi.fn(),
}))

import { AuthProvider, useAuth } from "../auth-provider"

const memberOf = (id: string) => ({ kind: "member", user: { id, email: `${id}@example.test`, displayName: id }, boards: [] })
const signedIn = (principal: unknown) => ({ authRequired: true, authenticated: true, canBootstrapLocal: false, accountsEnabled: true, hasAccounts: true, principal })

let refresh: () => Promise<void>

function Probe() {
  const auth = useAuth()
  refresh = () => auth.refresh({ bootstrapLocal: false })
  return <span data-testid="who">{auth.status === "paired" ? (auth.principal && "user" in auth.principal ? auth.principal.user.id : auth.principal?.kind ?? "none") : auth.status}</span>
}

async function boot() {
  render(<AuthProvider><Probe /></AuthProvider>)
  await waitFor(() => expect(screen.getByTestId("who").textContent).not.toBe("checking"))
}

beforeEach(() => {
  queryClient.clear()
  getAuthState.mockReset()
})

describe("the cache across a change of principal", () => {
  it("drops the first member's data when a different member is signed in", async () => {
    getAuthState.mockResolvedValue(signedIn(memberOf("first")))
    await boot()
    queryClient.setQueryData(["work-item", "PLT-1"], { title: "the first person's Todo" })
    getAuthState.mockResolvedValue(signedIn(memberOf("second")))
    await act(async () => { await refresh() })
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("second"))
    expect(queryClient.getQueryData(["work-item", "PLT-1"])).toBeUndefined()
  })

  it("drops a member's data when the operator takes the tab, and the operator's when a member does", async () => {
    getAuthState.mockResolvedValue(signedIn(memberOf("first")))
    await boot()
    queryClient.setQueryData(["boards"], "member's")
    getAuthState.mockResolvedValue(signedIn({ kind: "operator" }))
    await act(async () => { await refresh() })
    expect(queryClient.getQueryData(["boards"])).toBeUndefined()
    queryClient.setQueryData(["boards"], "operator's")
    getAuthState.mockResolvedValue(signedIn(memberOf("third")))
    await act(async () => { await refresh() })
    expect(queryClient.getQueryData(["boards"])).toBeUndefined()
  })

  it("keeps the cache when the same person is read again", async () => {
    getAuthState.mockResolvedValue(signedIn(memberOf("first")))
    await boot()
    queryClient.setQueryData(["work-item", "PLT-1"], { title: "kept" })
    await act(async () => { await refresh() })
    expect(queryClient.getQueryData(["work-item", "PLT-1"])).toEqual({ title: "kept" })
  })
})
