import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePersonChoices } from "../use-person-choices"

const api = vi.hoisted(() => ({ listPeople: vi.fn(), getMemberPeople: vi.fn() }))
const auth = vi.hoisted(() => ({ value: null as unknown }))
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: api }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)
const person = (id: string, boards: string[], over: Record<string, unknown> = {}) => ({
  id, displayName: id.toUpperCase(), initials: id[0].toUpperCase(), instanceRole: "member", status: "active", boards: boards.map((department) => ({ department, role: "collaborator" })), ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("usePersonChoices", () => {
  it("asks nothing where there are no accounts", () => {
    auth.value = { principal: null, authState: { accountsEnabled: true, hasAccounts: false } }
    const { result } = renderHook(() => usePersonChoices("ops"), { wrapper })
    expect(result.current).toEqual({ people: [], ready: true })
    expect(api.listPeople).not.toHaveBeenCalled()
    expect(api.getMemberPeople).not.toHaveBeenCalled()
  })

  it("lets the operator choose active people with a grant on that board, and instance owners, and no one else", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    api.listPeople.mockResolvedValue([
      person("ada", ["ops"]), person("bo", ["design"]), person("cy", [], { instanceRole: "owner" }), person("di", ["ops"], { status: "disabled" }),
    ])
    const { result } = renderHook(() => usePersonChoices("ops"), { wrapper })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.people.map((p) => p.id)).toEqual(["ada", "cy"])
  })

  it("asks a member for the people of that one board", async () => {
    auth.value = { principal: { kind: "member", user: { id: "me" }, boards: [] }, authState: { accountsEnabled: true, hasAccounts: true } }
    api.getMemberPeople.mockResolvedValue({ people: [{ id: "ada", displayName: "Ada", initials: "A" }], employees: [] })
    const { result } = renderHook(() => usePersonChoices("ops"), { wrapper })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(api.getMemberPeople).toHaveBeenCalledWith("ops")
    expect(result.current.people.map((p) => p.id)).toEqual(["ada"])
  })
})
