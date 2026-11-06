import { useState } from "react"
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { SettingsSelect } from "@/routes/settings/shared"
import { PEOPLE_DIRECTORY_KEY } from "@/hooks/use-people-directory"
import { MEMBER_BOARDS_KEY } from "@/hooks/use-principal"
import {
  BOARD_ROLE_LABEL,
  type BoardMemberWire,
  type BoardRole,
  type BoardRosterWire,
  type MemberBoardWire,
  type PendingInviteWire,
} from "@/lib/accounts-api"
import { accountsErrorText, formatWhen } from "./errors"
import { BoardInviteForm } from "./board-invite-form"
import { ceilingOf, endpoints, HEADING, rank, roleOptions, type ShareMode } from "./share-support"

export type { ShareMode }

export interface BoardShareDialogProps {
  department: string
  mode: ShareMode
  /** The caller's own role on the board. Only read in member mode, where it caps what they may grant. */
  ownRole?: BoardRole
  /** The caller's user id, so a member owner can still take themselves off the board. */
  selfUserId?: string
  open: boolean
  onClose: () => void
  /** The caller took themselves off the board: the dialog has closed, and the page should leave the board too. */
  onLeft?: () => void
}


interface WriteHooks {
  onError: (error: string | null) => void
  /** A write changed the caller's own place on the board (left it, or changed their own role). */
  onSelfChanged: (left: boolean) => void
}

function useRosterWrites(mode: ShareMode, department: string, selfUserId: string | undefined, hooks: WriteHooks) {
  const queryClient = useQueryClient()
  const api = endpoints(mode)
  const refresh = async (selfChanged = false) => {
    await Promise.all([
      // After the caller's own place changed the roster may be closed to them: drop it rather than re-read it.
      selfChanged
        ? queryClient.removeQueries({ queryKey: rosterKey(mode, department) })
        : queryClient.invalidateQueries({ queryKey: rosterKey(mode, department) }),
      // The People page lists each person's boards, and names on Todos come from the directory.
      queryClient.invalidateQueries({ queryKey: ["people"] }),
      queryClient.invalidateQueries({ queryKey: PEOPLE_DIRECTORY_KEY }),
      // A member's boards, tabs and Share button read their grants from this list.
      mode === "member" ? queryClient.invalidateQueries({ queryKey: MEMBER_BOARDS_KEY }) : undefined,
    ])
  }
  /** Leaving, or stepping down from owner, ends what the dialog may show: close it before anything re-reads the roster.
   *  The member's own board list is corrected at once, before the page moves: their home sends someone with one board
   *  straight to it, so a list that still held the board they left would send them back there. */
  const afterWrite = (userId: string, change: { left: true } | { role: BoardRole }) => {
    const self = mode === "member" && userId === selfUserId
    if (self) {
      queryClient.setQueryData<MemberBoardWire[]>(MEMBER_BOARDS_KEY, (boards) =>
        boards && ("left" in change
          ? boards.filter((board) => board.department !== department)
          : boards.map((board) => (board.department === department ? { ...board, role: change.role } : board))))
      hooks.onSelfChanged("left" in change)
    }
    return refresh(self)
  }
  const fail = (e: unknown) => hooks.onError(accountsErrorText(e))
  return {
    refresh,
    setRole: useMutation({
      mutationFn: ({ userId, role }: { userId: string; role: BoardRole }) => api.setRole(department, userId, role),
      onSuccess: (_data, { userId, role }) => afterWrite(userId, { role }),
      onError: fail,
    }),
    remove: useMutation({ mutationFn: (userId: string) => api.remove(department, userId), onSuccess: (_data, userId) => afterWrite(userId, { left: true }), onError: fail }),
    revoke: useMutation({ mutationFn: (id: string) => api.revoke(department, id), onSuccess: () => refresh(), onError: fail }),
  }
}

function rosterKey(mode: ShareMode, department: string) {
  return ["board-roster", mode, department] as const
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" data-testid="share-error" className="mt-3 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_10%,transparent)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--system-red)]">
      {message}
    </div>
  )
}

export function BoardShareDialog({ department, mode, ownRole, selfUserId, open, onClose, onLeft }: BoardShareDialogProps) {
  const ceiling = ceilingOf(mode, ownRole)
  const roster = useQuery<BoardRosterWire>({ queryKey: rosterKey(mode, department), queryFn: () => endpoints(mode).roster(department), enabled: open })
  const [error, setError] = useState<string | null>(null)
  const writes = useRosterWrites(mode, department, selfUserId, {
    onError: setError,
    onSelfChanged: (left) => {
      onClose()
      if (left) onLeft?.()
    },
  })
  const invites = roster.data?.invites ?? []
  const busy = writes.setRole.isPending || writes.remove.isPending

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[85dvh] max-w-[520px] overflow-y-auto border-0" overlayClassName="bg-[var(--scrim)]" showCloseButton>
        <DialogTitle>Share {department}</DialogTitle>
        <DialogDescription>
          People you add see this board and nothing else. Each one has a role that decides what they can do on it.
        </DialogDescription>
        {error && <ErrorBanner message={error} />}
        <MembersList
          roster={roster}
          mode={mode}
          ceiling={ceiling}
          selfUserId={selfUserId}
          busy={busy}
          onRole={(userId, role) => { setError(null); writes.setRole.mutate({ userId, role }) }}
          onRemove={(userId) => { setError(null); writes.remove.mutate(userId) }}
        />
        <BoardInviteForm department={department} mode={mode} ceiling={ceiling} onSent={writes.refresh} />
        {invites.length > 0 && (
          <section aria-label="Pending invites" className="mt-5">
            <h3 className={HEADING}>Pending invites</h3>
            <ul className="flex flex-col gap-2">
              {invites.map((invite) => (
                <PendingInviteRow key={invite.id} invite={invite} busy={writes.revoke.isPending} onRevoke={() => { setError(null); writes.revoke.mutate(invite.id) }} />
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}

function MembersList({ roster, mode, ceiling, selfUserId, busy, onRole, onRemove }: {
  roster: UseQueryResult<BoardRosterWire>
  mode: ShareMode
  ceiling: BoardRole
  selfUserId: string | undefined
  busy: boolean
  onRole: (userId: string, role: BoardRole) => void
  onRemove: (userId: string) => void
}) {
  const members = roster.data?.members ?? []
  return (
    <section aria-label="Members" className="mt-4">
      <h3 className={HEADING}>Members</h3>
      {roster.isPending && <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Loading…</p>}
      {roster.isError && <p role="alert" className="text-[length:var(--text-footnote)] text-[var(--system-red)]">{accountsErrorText(roster.error, "Couldn't load the members.")}</p>}
      {roster.isSuccess && members.length === 0 && <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Nobody has been added to this board yet.</p>}
      <ul className="flex flex-col gap-2">
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            reach={reachOf(member, mode, ceiling, member.userId === selfUserId)}
            ceiling={ceiling}
            busy={busy}
            onRole={(role) => onRole(member.userId, role)}
            onRemove={() => onRemove(member.userId)}
          />
        ))}
      </ul>
    </section>
  )
}

interface Reach {
  isSelf: boolean
  /** Their role can be changed. */
  role: boolean
  /** They can be taken off the board. */
  remove: boolean
}

/** A board owner cannot reach above their own role, nor any other owner; they can still take themselves off. */
function reachOf(member: BoardMemberWire, mode: ShareMode, ceiling: BoardRole, isSelf: boolean): Reach {
  const otherOwner = mode === "member" && member.role === "owner" && !isSelf
  const role = rank(member.role) <= rank(ceiling) && !otherOwner
  return { isSelf, role, remove: isSelf || role }
}

function MemberRow({ member, reach, ceiling, busy, onRole, onRemove }: {
  member: BoardMemberWire
  reach: Reach
  ceiling: BoardRole
  busy: boolean
  onRole: (role: BoardRole) => void
  onRemove: () => void
}) {
  return (
    <li data-testid={`share-member-${member.userId}`} className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-2.5">
      <div className="flex items-center gap-2.5">
        <HumanAvatar name={member.displayName} initials={member.initials} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{member.displayName}{reach.isSelf ? " (you)" : ""}</div>
          <div className="truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{member.email}</div>
        </div>
        <div className="w-[130px] shrink-0">
          {reach.role ? (
            <SettingsSelect ariaLabel={`Role for ${member.displayName}`} value={member.role} onChange={(value) => onRole(value as BoardRole)} options={roleOptions(ceiling)} />
          ) : (
            <span className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">{BOARD_ROLE_LABEL[member.role]}</span>
          )}
        </div>
      </div>
      {reach.remove && <RemoveControl name={member.displayName} isSelf={reach.isSelf} busy={busy} onRemove={onRemove} />}
    </li>
  )
}

function RemoveControl({ name, isSelf, busy, onRemove }: { name: string; isSelf: boolean; busy: boolean; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const verb = isSelf ? "Leave" : "Remove"
  if (!confirming) {
    return (
      <div>
        <Button size="sm" variant="ghost" aria-label={`${verb} ${name}`} onClick={() => setConfirming(true)}>
          {isSelf ? "Leave board" : "Remove"}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-footnote)]">
      <span className="text-[var(--text-secondary)]">{isSelf ? "Leave this board?" : `Remove ${name} from this board?`}</span>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setConfirming(false); onRemove() }}>{verb}</Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
    </div>
  )
}

function PendingInviteRow({ invite, busy, onRevoke }: { invite: PendingInviteWire; busy: boolean; onRevoke: () => void }) {
  return (
    <li data-testid={`share-invite-${invite.id}`} className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{invite.email}</div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {invite.role ? BOARD_ROLE_LABEL[invite.role] : "Member"} · expires {formatWhen(invite.expiresAt)}
        </div>
      </div>
      <Button size="sm" variant="ghost" disabled={busy} aria-label={`Revoke invite for ${invite.email}`} onClick={onRevoke}>Revoke</Button>
    </li>
  )
}
