import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingInviteWire, PersonWire } from "@/lib/accounts-api"

const api = vi.hoisted(() => ({
  listPeople: vi.fn(),
  listPendingInvites: vi.fn(),
  listPersonSessions: vi.fn(),
  revokePersonSession: vi.fn(),
  revokeAllPersonSessions: vi.fn(),
  issueResetLink: vi.fn(),
  updatePerson: vi.fn(),
  setBoardRole: vi.fn(),
  deletePerson: vi.fn(),
  inviteToInstance: vi.fn(),
  revokeInvite: vi.fn(),
  setupOwnSignIn: vi.fn(),
}))
vi.mock("@/lib/accounts-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounts-api")>()
  return { ...actual, accountsApi: api }
})
const copyText = vi.hoisted(() => vi.fn(async () => ({ status: "performed" })))
vi.mock("@/platform", () => ({ copyText }))

let authState: { accountsEnabled?: boolean } | null = { accountsEnabled: true }
const refreshAuth = vi.hoisted(() => vi.fn(async () => {}))
const rereadAuth = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/routes/auth-provider", () => ({
  useAuth: () => ({ authState, principal: { kind: "operator" }, refresh: refreshAuth, reread: rereadAuth }),
  useAuthOptional: () => ({ authState, principal: { kind: "operator" }, refresh: refreshAuth, reread: rereadAuth }),
}))

import { PeopleEntry } from "../entry"

const owner: PersonWire = { id: "usr_owner", email: "owner@example.com", displayName: "Olive Owner", initials: "OO", instanceRole: "owner", status: "active", boards: [], passwordSet: true, lastSeenAt: null }
const member: PersonWire = {
  id: "usr_mem", email: "sam@example.com", displayName: "Sam Member", initials: "SM", instanceRole: "member", status: "active",
  boards: [{ department: "design", role: "collaborator" }, { department: "ops", role: "viewer" }], passwordSet: false,
}
const memberInvite: PendingInviteWire = { id: "utk_a", email: "new@example.com", department: "design", role: "viewer", instanceRole: null, createdBy: "operator", createdAt: "2026-11-05T10:00:00Z", expiresAt: "2026-11-12T10:00:00Z" }
const ownerInvite: PendingInviteWire = { id: "utk_b", email: "coop@example.com", department: null, role: null, instanceRole: "owner", createdBy: "operator", createdAt: "2026-11-01T10:00:00Z", expiresAt: "2026-11-07T10:00:00Z" }

function renderEntry() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PeopleEntry />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  authState = { accountsEnabled: true }
  api.listPeople.mockResolvedValue([owner, member])
  api.listPendingInvites.mockResolvedValue([])
})
afterEach(() => {
  vi.clearAllMocks()
})

describe("Settings → People gating", () => {
  it("renders nothing and asks for nothing when accountsEnabled is absent", () => {
    authState = {}
    const { container } = renderEntry()
    expect(container.innerHTML).toBe("")
    expect(api.listPeople).not.toHaveBeenCalled()
  })

  it("renders nothing before the first auth state has landed", () => {
    authState = null
    const { container } = renderEntry()
    expect(container.innerHTML).toBe("")
  })

  it("says accounts need gateway auth when they are off, without loading the section", () => {
    authState = { accountsEnabled: false }
    renderEntry()
    expect(screen.getByTestId("people-needs-auth").textContent).toMatch(/gateway auth/i)
    expect(api.listPeople).not.toHaveBeenCalled()
  })
})

describe("People list", () => {
  it("shows each person's role, status, boards and missing password", async () => {
    renderEntry()
    const sam = await screen.findByTestId("person-usr_mem")
    expect(within(sam).getByText("Sam Member")).toBeTruthy()
    expect(screen.getByTestId("person-role-usr_mem").textContent).toBe("Member")
    expect(screen.getByTestId("person-role-usr_owner").textContent).toBe("Instance owner")
    expect(screen.getByTestId("person-status-usr_mem").textContent).toBe("Active")
    expect(within(sam).getByText("design · Collaborator")).toBeTruthy()
    expect(within(sam).getByText("ops · Viewer")).toBeTruthy()
    expect(within(sam).getByText(/no password set yet/i)).toBeTruthy()
  })

  it("offers set up my sign-in only while no active owner account exists, and checks the passwords", async () => {
    api.listPeople.mockResolvedValue([member])
    api.setupOwnSignIn.mockResolvedValue({})
    renderEntry()
    const form = await screen.findByTestId("setup-own-sign-in")
    fireEvent.change(within(form).getByLabelText("Your email"), { target: { value: "me@example.com" } })
    fireEvent.change(within(form).getByLabelText("Your display name"), { target: { value: "Me" } })
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "short" } })
    fireEvent.change(within(form).getByLabelText("Repeat password"), { target: { value: "short" } })
    fireEvent.click(within(form).getByRole("button", { name: /set up sign-in/i }))
    expect((await within(form).findByRole("alert")).textContent).toMatch(/at least 12/)
    expect(api.setupOwnSignIn).not.toHaveBeenCalled()

    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "a-long-enough-password" } })
    fireEvent.change(within(form).getByLabelText("Repeat password"), { target: { value: "a-different-password" } })
    fireEvent.click(within(form).getByRole("button", { name: /set up sign-in/i }))
    expect((await within(form).findByRole("alert")).textContent).toMatch(/don't match/)

    fireEvent.change(within(form).getByLabelText("Repeat password"), { target: { value: "a-long-enough-password" } })
    api.listPeople.mockResolvedValue([owner, member])
    fireEvent.click(within(form).getByRole("button", { name: /set up sign-in/i }))
    await waitFor(() => expect(api.setupOwnSignIn).toHaveBeenCalledWith({ email: "me@example.com", displayName: "Me", password: "a-long-enough-password" }))
    await waitFor(() => expect(screen.queryByTestId("setup-own-sign-in")).toBeNull())
    // The tab's auth state is re-read, so the pickers see the new owner without a reload.
    expect(rereadAuth).toHaveBeenCalledTimes(1)
    expect(refreshAuth).not.toHaveBeenCalled()
  })

  it("hides set up my sign-in once an active owner exists", async () => {
    renderEntry()
    await screen.findByTestId("person-usr_owner")
    expect(screen.queryByTestId("setup-own-sign-in")).toBeNull()
  })

  it("shows a reset link once and drops it when dismissed", async () => {
    api.issueResetLink.mockResolvedValue({ link: "https://gw.example/reset#tok123", expiresAt: "2026-11-07T10:00:00Z" })
    renderEntry()
    fireEvent.click(await screen.findByRole("button", { name: "Issue reset link for Sam Member" }))
    const box = await screen.findByTestId("reset-link-usr_mem")
    expect((within(box).getByLabelText("Link") as HTMLInputElement).value).toBe("https://gw.example/reset#tok123")
    expect(box.textContent).toMatch(/shown once/i)
    fireEvent.click(within(box).getByTestId("reset-link-usr_mem-copy"))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("https://gw.example/reset#tok123"))
    fireEvent.click(within(box).getByTestId("reset-link-usr_mem-dismiss"))
    expect(screen.queryByTestId("reset-link-usr_mem")).toBeNull()
    expect(screen.queryByDisplayValue("https://gw.example/reset#tok123")).toBeNull()
  })

  it("lists a person's sessions and revokes one, then all", async () => {
    api.listPersonSessions.mockResolvedValue([
      { id: "uss_1", kind: "member", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-05T00:00:00Z", userAgent: "Firefox" },
      { id: "uss_2", kind: "device", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: null },
    ])
    api.revokePersonSession.mockResolvedValue(undefined)
    api.revokeAllPersonSessions.mockResolvedValue(undefined)
    renderEntry()
    fireEvent.click(await screen.findByRole("button", { name: "Sessions for Sam Member" }))
    const panel = await screen.findByTestId("sessions-usr_mem")
    expect(await within(panel).findByText("Firefox")).toBeTruthy()
    expect(within(panel).getByText("Operator device")).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Revoke session uss_1" }))
    await waitFor(() => expect(api.revokePersonSession).toHaveBeenCalledWith("usr_mem", "uss_1"))
    fireEvent.click(within(panel).getByRole("button", { name: /revoke all sessions/i }))
    await waitFor(() => expect(api.revokeAllPersonSessions).toHaveBeenCalledWith("usr_mem"))
  })

  it("disables an active person and enables a disabled one", async () => {
    api.updatePerson.mockResolvedValue({ person: member })
    renderEntry()
    fireEvent.click(await screen.findByRole("button", { name: "Disable Sam Member" }))
    await waitFor(() => expect(api.updatePerson).toHaveBeenCalledWith("usr_mem", { status: "disabled" }))
  })

  it("enables a disabled person", async () => {
    api.listPeople.mockResolvedValue([owner, { ...member, status: "disabled" }])
    api.updatePerson.mockResolvedValue({ person: member })
    renderEntry()
    expect((await screen.findByTestId("person-status-usr_mem")).textContent).toBe("Disabled")
    fireEvent.click(screen.getByRole("button", { name: "Enable Sam Member" }))
    await waitFor(() => expect(api.updatePerson).toHaveBeenCalledWith("usr_mem", { status: "active" }))
  })

  it("renames a person and removes one only after confirming", async () => {
    api.updatePerson.mockResolvedValue({ person: member })
    api.deletePerson.mockResolvedValue(undefined)
    renderEntry()
    fireEvent.click(await screen.findByRole("button", { name: "Rename Sam Member" }))
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Samantha" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(api.updatePerson).toHaveBeenCalledWith("usr_mem", { displayName: "Samantha" }))

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam Member" }))
    expect(api.deletePerson).not.toHaveBeenCalled()
    // Before the choice: what removing them clears on Todos that named them as the person.
    expect(screen.getByRole("alert").textContent).toContain("any Todo naming them as the person responsible loses its person")
    fireEvent.click(screen.getByRole("button", { name: "Remove person" }))
    await waitFor(() => expect(api.deletePerson).toHaveBeenCalledWith("usr_mem"))
  })

  it("words a 429 with the wait the gateway asked for", async () => {
    const { AccountsError } = await import("@/lib/accounts-api")
    api.issueResetLink.mockRejectedValue(new AccountsError(429, "slow down", 90))
    renderEntry()
    fireEvent.click(await screen.findByRole("button", { name: "Issue reset link for Sam Member" }))
    expect((await screen.findByTestId("person-error-usr_mem")).textContent).toBe("Too many attempts. Try again in 2 minutes.")
  })
})

describe("Changing roles", () => {
  const openRoles = async (name = "Sam Member") => {
    renderEntry()
    fireEvent.click(await screen.findByRole("button", { name: `Change roles for ${name}` }))
  }

  it("promotes a member to instance owner only after the co-operator warning is acknowledged", async () => {
    api.updatePerson.mockResolvedValue({ person: { ...member, instanceRole: "owner" } })
    await openRoles()
    fireEvent.change(screen.getByLabelText("Instance role for Sam Member"), { target: { value: "owner" } })
    const warning = screen.getByTestId("promote-warning-usr_mem")
    expect(warning.textContent).toMatch(/co-operator/i)
    expect(warning.textContent).toMatch(/same authority as you/i)
    expect(warning.textContent).toMatch(/every board/i)
    const apply = screen.getByRole("button", { name: "Make owner" }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(within(warning).getByRole("checkbox"))
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    await waitFor(() => expect(api.updatePerson).toHaveBeenCalledWith("usr_mem", { instanceRole: "owner" }))
    // The list is re-read, so the badge follows what the gateway holds.
    await waitFor(() => expect(api.listPeople.mock.calls.length).toBeGreaterThan(1))
  })

  it("demotes an instance owner back to member, saying what it ends", async () => {
    api.updatePerson.mockResolvedValue({ person: { ...owner, instanceRole: "member" } })
    api.listPeople.mockResolvedValue([owner, { ...member, instanceRole: "owner" }])
    await openRoles()
    fireEvent.change(screen.getByLabelText("Instance role for Sam Member"), { target: { value: "member" } })
    expect(screen.getByTestId("demote-note-usr_mem").textContent).toMatch(/operator devices are signed out/i)
    expect(screen.queryByTestId("promote-warning-usr_mem")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Make member" }))
    await waitFor(() => expect(api.updatePerson).toHaveBeenCalledWith("usr_mem", { instanceRole: "member" }))
  })

  it("offers no apply while nothing changed, on a member and on an owner, and sends nothing", async () => {
    api.listPeople.mockResolvedValue([owner, member])
    renderEntry()
    for (const name of ["Sam Member", "Olive Owner"]) {
      fireEvent.click(await screen.findByRole("button", { name: `Change roles for ${name}` }))
    }
    expect(screen.queryByRole("button", { name: "Make owner" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Make member" })).toBeNull()
    expect(api.updatePerson).not.toHaveBeenCalled()
  })

  it("sends nothing when the pick is cancelled", async () => {
    await openRoles()
    fireEvent.change(screen.getByLabelText("Instance role for Sam Member"), { target: { value: "owner" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("promote-warning-usr_mem")).toBeNull()
    expect((screen.getByLabelText("Instance role for Sam Member") as HTMLSelectElement).value).toBe("member")
    expect(api.updatePerson).not.toHaveBeenCalled()
  })

  it("shows a refused instance-role change and keeps the choice open", async () => {
    const { AccountsError } = await import("@/lib/accounts-api")
    api.updatePerson.mockRejectedValue(new AccountsError(403, "Not allowed"))
    await openRoles()
    fireEvent.change(screen.getByLabelText("Instance role for Sam Member"), { target: { value: "owner" } })
    fireEvent.click(within(screen.getByTestId("promote-warning-usr_mem")).getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }))
    expect((await screen.findByTestId("instance-role-error-usr_mem")).textContent).toContain("Not allowed")
  })

  it("changes each board grant between viewer, collaborator and owner", async () => {
    api.setBoardRole.mockResolvedValue(undefined)
    await openRoles()
    const design = screen.getByLabelText("Role for Sam Member on design") as HTMLSelectElement
    expect(design.value).toBe("collaborator")
    expect((screen.getByLabelText("Role for Sam Member on ops") as HTMLSelectElement).value).toBe("viewer")
    expect(Array.from(design.options).map((o) => o.value)).toEqual(["viewer", "collaborator", "owner"])
    fireEvent.change(design, { target: { value: "owner" } })
    await waitFor(() => expect(api.setBoardRole).toHaveBeenCalledWith("design", "usr_mem", "owner"))
    fireEvent.change(screen.getByLabelText("Role for Sam Member on ops"), { target: { value: "collaborator" } })
    await waitFor(() => expect(api.setBoardRole).toHaveBeenCalledWith("ops", "usr_mem", "collaborator"))
    expect(api.updatePerson).not.toHaveBeenCalled()
  })

  it("shows a refused board-role change on that board's row", async () => {
    const { AccountsError } = await import("@/lib/accounts-api")
    api.setBoardRole.mockRejectedValue(new AccountsError(404, "Not found"))
    await openRoles()
    fireEvent.change(screen.getByLabelText("Role for Sam Member on design"), { target: { value: "viewer" } })
    const row = screen.getByTestId("board-role-usr_mem-design")
    expect((await within(row).findByRole("alert")).textContent).toBeTruthy()
    expect((screen.getByLabelText("Role for Sam Member on design") as HTMLSelectElement).value).toBe("collaborator")
  })

  it("says so for a person on no boards", async () => {
    api.listPeople.mockResolvedValue([owner])
    await openRoles("Olive Owner")
    expect(screen.getByTestId("roles-usr_owner").textContent).toMatch(/no boards/i)
  })
})

describe("Invite to the instance", () => {
  it("sends a member invite and shows its link once", async () => {
    api.inviteToInstance.mockResolvedValue({ link: "https://gw.example/invite#abc", expiresAt: "2026-11-13T00:00:00Z" })
    renderEntry()
    const form = await screen.findByTestId("invite-instance")
    fireEvent.change(within(form).getByLabelText("Invitee email"), { target: { value: "a@example.com" } })
    expect(screen.queryByTestId("owner-invite-warning")).toBeNull()
    fireEvent.click(within(form).getByRole("button", { name: "Send invite" }))
    await waitFor(() => expect(api.inviteToInstance).toHaveBeenCalledWith("a@example.com", "member"))
    const box = await screen.findByTestId("invite-instance-link")
    expect((within(box).getByLabelText("Link") as HTMLInputElement).value).toBe("https://gw.example/invite#abc")
    fireEvent.click(within(box).getByTestId("invite-instance-link-dismiss"))
    expect(screen.queryByTestId("invite-instance-link")).toBeNull()
  })

  it("warns about co-operators and needs an explicit second step before an owner invite is sent", async () => {
    api.inviteToInstance.mockResolvedValue({ link: "https://gw.example/invite#own" })
    renderEntry()
    const form = await screen.findByTestId("invite-instance")
    fireEvent.change(within(form).getByLabelText("Invitee email"), { target: { value: "coop@example.com" } })
    fireEvent.change(within(form).getByLabelText("Instance role"), { target: { value: "owner" } })
    const warning = screen.getByTestId("owner-invite-warning")
    expect(warning.textContent).toMatch(/co-operator/i)
    expect(warning.textContent).toMatch(/same authority as you/i)
    expect(warning.textContent).toMatch(/24 hours/)
    const send = within(form).getByRole("button", { name: "Invite co-operator" }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.submit(form)
    expect(api.inviteToInstance).not.toHaveBeenCalled()
    fireEvent.click(within(warning).getByRole("checkbox"))
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => expect(api.inviteToInstance).toHaveBeenCalledWith("coop@example.com", "owner"))
  })

  it("says so when the address already has an account", async () => {
    api.inviteToInstance.mockResolvedValue({ granted: true })
    renderEntry()
    const form = await screen.findByTestId("invite-instance")
    fireEvent.change(within(form).getByLabelText("Invitee email"), { target: { value: "sam@example.com" } })
    fireEvent.click(within(form).getByRole("button", { name: "Send invite" }))
    expect((await screen.findByTestId("invite-instance-granted")).textContent).toMatch(/already have an account/)
    expect(screen.queryByTestId("invite-instance-link")).toBeNull()
  })
})

describe("Pending invites", () => {
  it("lists an owner invite first and prominently, with its scope, and revokes one", async () => {
    api.listPendingInvites.mockResolvedValue([memberInvite, ownerInvite])
    api.revokeInvite.mockResolvedValue(undefined)
    renderEntry()
    const list = await screen.findByTestId("pending-invites")
    const rows = await within(list).findAllByTestId(/^pending-invite-/)
    expect(rows.map((row) => row.dataset.testid)).toEqual(["pending-invite-utk_b", "pending-invite-utk_a"])
    expect(rows[0].dataset.ownerInvite).toBe("true")
    expect(rows[1].dataset.ownerInvite).toBeUndefined()
    expect(within(rows[0]).getByText("Co-operator invite")).toBeTruthy()
    expect(within(rows[0]).getByText(/Instance · Owner/)).toBeTruthy()
    expect(within(rows[1]).getByText(/design · Viewer/)).toBeTruthy()
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Revoke invite for coop@example.com" }))
    await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledWith("utk_b"))
  })
})
