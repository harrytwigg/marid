import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BoardRosterWire } from "@/lib/accounts-api"

const api = vi.hoisted(() => ({
  getBoardRoster: vi.fn(),
  inviteToBoard: vi.fn(),
  revokeBoardInvite: vi.fn(),
  setBoardRole: vi.fn(),
  removeBoardMember: vi.fn(),
  getMemberBoardRoster: vi.fn(),
  memberInviteToBoard: vi.fn(),
  memberRevokeBoardInvite: vi.fn(),
  memberSetBoardRole: vi.fn(),
  memberRemoveBoardMember: vi.fn(),
}))
vi.mock("@/lib/accounts-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounts-api")>()
  return { ...actual, accountsApi: api }
})
vi.mock("@/platform", () => ({ copyText: vi.fn(async () => ({ status: "performed" })) }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => null }))

import "@/test/preload-dialogs"
import { BoardShareDialog, type BoardShareDialogProps } from "../board-share-dialog"
import { MEMBER_BOARDS_KEY } from "@/hooks/use-principal"
import { useState } from "react"

const roster: BoardRosterWire = {
  members: [
    { userId: "usr_me", displayName: "Me Owner", email: "me@example.com", initials: "MO", role: "owner" },
    { userId: "usr_o2", displayName: "Other Owner", email: "o2@example.com", initials: "OO", role: "owner" },
    { userId: "usr_c", displayName: "Cass Collab", email: "cass@example.com", initials: "CC", role: "collaborator" },
  ],
  invites: [{ id: "utk_1", email: "pending@example.com", department: "design", role: "viewer", instanceRole: null, createdBy: "operator", createdAt: "2026-11-05T00:00:00Z", expiresAt: "2026-11-12T00:00:00Z" }],
}

function renderDialog(props: Partial<BoardShareDialogProps> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BoardShareDialog department="design" mode="operator" open onClose={() => {}} {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.getBoardRoster.mockResolvedValue(roster)
  api.getMemberBoardRoster.mockResolvedValue(roster)
})
afterEach(() => vi.clearAllMocks())

describe("BoardShareDialog as the operator", () => {
  it("lists members and pending invites", async () => {
    renderDialog()
    expect(await screen.findByTestId("share-member-usr_c")).toBeTruthy()
    expect(api.getBoardRoster).toHaveBeenCalledWith("design")
    expect(screen.getByTestId("share-invite-utk_1").textContent).toContain("pending@example.com")
  })

  it("invites with a role and shows the link once", async () => {
    api.inviteToBoard.mockResolvedValue({ link: "https://gw.example/invite#tok", expiresAt: "2026-11-12T00:00:00Z" })
    renderDialog()
    await screen.findByTestId("share-member-usr_c")
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } })
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "collaborator" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))
    await waitFor(() => expect(api.inviteToBoard).toHaveBeenCalledWith("design", "new@example.com", "collaborator"))
    const link = await screen.findByTestId("share-link")
    expect((within(link).getByLabelText("Link") as HTMLInputElement).value).toBe("https://gw.example/invite#tok")
    expect(link.textContent).toMatch(/revokes this link/)
    fireEvent.click(within(link).getByTestId("share-link-dismiss"))
    expect(screen.queryByTestId("share-link")).toBeNull()
  })

  it("says so, with no link, when the address already has an account", async () => {
    api.inviteToBoard.mockResolvedValue({ granted: true })
    renderDialog()
    await screen.findByTestId("share-member-usr_c")
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))
    expect((await screen.findByTestId("share-granted")).textContent).toMatch(/already have an account/)
    expect(screen.queryByTestId("share-link")).toBeNull()
  })

  it("changes a role, removes a member after confirming, and revokes an invite", async () => {
    api.setBoardRole.mockResolvedValue(undefined)
    api.removeBoardMember.mockResolvedValue(undefined)
    api.revokeBoardInvite.mockResolvedValue(undefined)
    renderDialog()
    await screen.findByTestId("share-member-usr_c")
    fireEvent.change(screen.getByLabelText("Role for Cass Collab"), { target: { value: "viewer" } })
    await waitFor(() => expect(api.setBoardRole).toHaveBeenCalledWith("design", "usr_c", "viewer"))

    fireEvent.click(screen.getByRole("button", { name: "Remove Cass Collab" }))
    expect(api.removeBoardMember).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByTestId("share-member-usr_c")).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(api.removeBoardMember).toHaveBeenCalledWith("design", "usr_c"))

    fireEvent.click(screen.getByRole("button", { name: "Revoke invite for pending@example.com" }))
    await waitFor(() => expect(api.revokeBoardInvite).toHaveBeenCalledWith("design", "utk_1"))
  })

  it("can change any owner's role, including to owner", async () => {
    renderDialog()
    await screen.findByTestId("share-member-usr_o2")
    const select = screen.getByLabelText("Role for Other Owner") as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(["viewer", "collaborator", "owner"])
    expect(screen.getByRole("button", { name: "Remove Other Owner" })).toBeTruthy()
  })
})

describe("BoardShareDialog as a board owner", () => {
  it("uses the member routes", async () => {
    api.memberInviteToBoard.mockResolvedValue({ link: "https://gw.example/invite#m" })
    renderDialog({ mode: "member", ownRole: "owner", selfUserId: "usr_me" })
    await screen.findByTestId("share-member-usr_c")
    expect(api.getMemberBoardRoster).toHaveBeenCalledWith("design")
    expect(api.getBoardRoster).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "x@example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))
    await waitFor(() => expect(api.memberInviteToBoard).toHaveBeenCalledWith("design", "x@example.com", "viewer"))
    expect(api.inviteToBoard).not.toHaveBeenCalled()
  })

  it("cannot touch another owner but can leave the board themselves", async () => {
    api.memberRemoveBoardMember.mockResolvedValue(undefined)
    renderDialog({ mode: "member", ownRole: "owner", selfUserId: "usr_me" })
    await screen.findByTestId("share-member-usr_o2")
    expect(screen.queryByLabelText("Role for Other Owner")).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove Other Owner" })).toBeNull()
    expect(screen.getByTestId("share-member-usr_o2").textContent).toContain("Owner")
    fireEvent.click(screen.getByRole("button", { name: "Leave Me Owner" }))
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(api.memberRemoveBoardMember).toHaveBeenCalledWith("design", "usr_me"))
  })

  it("caps the roles on offer at the caller's own role", async () => {
    renderDialog({ mode: "member", ownRole: "collaborator", selfUserId: "usr_x" })
    await screen.findByTestId("share-member-usr_c")
    const invite = screen.getByLabelText("Role") as HTMLSelectElement
    expect([...invite.options].map((o) => o.value)).toEqual(["viewer", "collaborator"])
    const rowRole = screen.getByLabelText("Role for Cass Collab") as HTMLSelectElement
    expect([...rowRole.options].map((o) => o.value)).toEqual(["viewer", "collaborator"])
    // An owner is above a collaborator's reach entirely.
    expect(screen.queryByLabelText("Role for Me Owner")).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove Me Owner" })).toBeNull()
  })
})

describe("BoardShareDialog when the owner changes their own place", () => {
  /** Mounted the way the Share button mounts it: closing unmounts it. */
  function Harness({ client, ...props }: Partial<BoardShareDialogProps> & { client: QueryClient }) {
    const [open, setOpen] = useState(true)
    return (
      <QueryClientProvider client={client}>
        {open && <BoardShareDialog department="design" mode="member" ownRole="owner" selfUserId="usr_me" open {...props} onClose={() => { setOpen(false); props.onClose?.() }} />}
      </QueryClientProvider>
    )
  }
  function setup(props: Partial<BoardShareDialogProps> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const onClose = vi.fn()
    const onLeft = vi.fn()
    render(<Harness client={client} onClose={onClose} onLeft={onLeft} {...props} />)
    const boardsInvalidated = () => invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(MEMBER_BOARDS_KEY))
    return { onClose, onLeft, boardsInvalidated }
  }

  it("leaving closes the dialog, re-reads the member's boards and hands the page off, without re-reading the roster it lost", async () => {
    api.memberRemoveBoardMember.mockResolvedValue(undefined)
    const { onClose, onLeft, boardsInvalidated } = setup()
    await screen.findByTestId("share-member-usr_me")
    fireEvent.click(screen.getByRole("button", { name: "Leave Me Owner" }))
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(boardsInvalidated()).toBe(true))
    expect(screen.queryByTestId("share-member-usr_me")).toBeNull()
    expect(api.getMemberBoardRoster).toHaveBeenCalledTimes(1)
  })

  it("stepping down from owner closes the dialog and re-reads their boards, but does not leave the board", async () => {
    api.memberSetBoardRole.mockResolvedValue(undefined)
    const { onClose, onLeft, boardsInvalidated } = setup()
    await screen.findByTestId("share-member-usr_me")
    fireEvent.change(screen.getByLabelText("Role for Me Owner"), { target: { value: "collaborator" } })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.memberSetBoardRole).toHaveBeenCalledWith("design", "usr_me", "collaborator")
    expect(onLeft).not.toHaveBeenCalled()
    await waitFor(() => expect(boardsInvalidated()).toBe(true))
  })

  it("removing someone else keeps the dialog open", async () => {
    api.memberRemoveBoardMember.mockResolvedValue(undefined)
    const { onClose, onLeft } = setup()
    await screen.findByTestId("share-member-usr_c")
    fireEvent.click(screen.getByRole("button", { name: "Remove Cass Collab" }))
    fireEvent.click(within(screen.getByTestId("share-member-usr_c")).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(api.memberRemoveBoardMember).toHaveBeenCalledWith("design", "usr_c"))
    await waitFor(() => expect(api.getMemberBoardRoster).toHaveBeenCalledTimes(2))
    expect(onClose).not.toHaveBeenCalled()
    expect(onLeft).not.toHaveBeenCalled()
  })
})
