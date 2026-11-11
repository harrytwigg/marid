import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

let auth: { principal: unknown; authState: Record<string, unknown> } | null = null
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth }))
const getMemberPeople = vi.fn()
const listPeople = vi.fn()
vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api")
  return { ...actual, accountsApi: { ...actual.accountsApi, getMemberPeople: (...a: unknown[]) => getMemberPeople(...a), listPeople: (...a: unknown[]) => listPeople(...a) } }
})

import { usePeopleDirectory } from "../use-people-directory"

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

beforeEach(() => {
  getMemberPeople.mockReset()
  listPeople.mockReset()
})

describe("a user: id the directory cannot name", () => {
  it("is a former member, not a name still on its way, when accounts are off", () => {
    auth = { principal: { kind: "operator" }, authState: { accountsEnabled: false } }
    const { result } = renderHook(() => usePeopleDirectory(), { wrapper })
    expect(result.current.resolve("user:gone")).toEqual({ kind: "former" })
    expect(listPeople).not.toHaveBeenCalled()
  })

  it("is still asked about while accounts are enabled but none existed when the page loaded", async () => {
    auth = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: false } }
    listPeople.mockResolvedValue([{ id: "u2", displayName: "Una Two", initials: "UT" }])
    const { result } = renderHook(() => usePeopleDirectory(), { wrapper })
    expect(result.current.resolve("user:u2")).toEqual({ kind: "pending" })
    await waitFor(() => expect(result.current.resolve("user:u2")).toMatchObject({ kind: "member", displayName: "Una Two" }))
  })

  it("is a former member once the directory read has failed", async () => {
    auth = { principal: { kind: "member", user: { id: "u1", email: "m@example.test", displayName: "M" }, boards: [] }, authState: {} }
    getMemberPeople.mockRejectedValue(new Error("down"))
    const { result } = renderHook(() => usePeopleDirectory(), { wrapper })
    expect(result.current.resolve("user:u2")).toEqual({ kind: "pending" })
    await waitFor(() => expect(result.current.resolve("user:u2")).toEqual({ kind: "former" }))
  })

  it("is still pending while the read is in flight", () => {
    auth = { principal: { kind: "member", user: { id: "u1", email: "m@example.test", displayName: "M" }, boards: [] }, authState: {} }
    getMemberPeople.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => usePeopleDirectory(), { wrapper })
    expect(result.current.resolve("user:u2")).toEqual({ kind: "pending" })
  })
})
