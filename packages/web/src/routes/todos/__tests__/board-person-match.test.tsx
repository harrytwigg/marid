import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useBoardData } from "../board/use-board"

/* With one owner account the operator is that account, so the board's "Me" asks the list for both of the operator's
 * identities: Todos a member named the owner on by account are the operator's too. */

const auth = vi.hoisted(() => ({ value: null as unknown }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
const listPeople = vi.hoisted(() => vi.fn())
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: { listPeople } }))
const listWorkItems = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, listWorkItems } }
})

const owner = { id: "u3", email: "owner@example.test", displayName: "Owen Poe", initials: "OP", instanceRole: "owner", status: "active", boards: [] }
const second = { ...owner, id: "u5", email: "second@example.test", displayName: "Ola Toe", initials: "OT" }

function board(person: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useBoardData({ kind: "everything" }, { status: "executing", person }, Date.now()), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}
const asked = () => listWorkItems.mock.calls.map(([params]) => params?.humanAssignee)

beforeEach(() => {
  listWorkItems.mockResolvedValue({ workItems: [], total: 0, nextOffset: null })
})
afterEach(() => vi.clearAllMocks())

describe("the board's Me", () => {
  it("with one owner, asks for the desk and the owner's account together", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { hasAccounts: true } }
    listPeople.mockResolvedValue([owner])
    board("@operator")
    await waitFor(() => expect(asked()).toContain("@operator,user:u3"))
  })

  it("with several owners, asks for the shared desk alone", async () => {
    auth.value = { principal: { kind: "operator", user: { id: "u3", displayName: "Owen Poe" } }, authState: { hasAccounts: true } }
    listPeople.mockResolvedValue([owner, second])
    board("@operator")
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    await waitFor(() => expect(asked().length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked().every((value) => value === "@operator")).toBe(true)
  })

  it("with no accounts, asks for the desk as always and reads no people", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { hasAccounts: false } }
    board("@operator")
    await waitFor(() => expect(asked()).toContain("@operator"))
    expect(asked().every((value) => value === "@operator")).toBe(true)
    expect(listPeople).not.toHaveBeenCalled()
  })
})
