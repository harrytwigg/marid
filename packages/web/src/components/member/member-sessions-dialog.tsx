import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import { Button } from "@/components/ui/button"
import { accountsApi, type UserSessionWire } from "@/lib/accounts-api"
import { getAuthState } from "@/lib/auth"
import { useAuth } from "@/routes/auth-provider"
import { accountsErrorText } from "@/components/people/errors"
import { formatRelativeTime } from "@/routes/todos/util"

const KEY = ["member", "sessions"] as const

function label(session: UserSessionWire): string {
  const agent = session.userAgent?.trim()
  return agent ? agent.slice(0, 80) : "Browser"
}

/** Whether the gateway no longer knows this browser as a member (or cannot be asked, which counts as still in). */
async function signedOut(): Promise<boolean> {
  try {
    return (await getAuthState()).principal?.kind !== "member"
  } catch {
    return false
  }
}

/** The member's own sessions: where they are signed in, and a way to end the ones they don't recognise. */
export function MemberSessionsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { refresh } = useAuth()
  const sessions = useQuery({ queryKey: KEY, queryFn: accountsApi.listMemberSessions })
  const revoke = useMutation({
    mutationFn: (session: UserSessionWire) => accountsApi.revokeMemberSession(session.id),
    // Ending the session this browser holds ends this page's access too, and `current` says which row that is. If a
    // gateway leaves it out, a row not known to be another browser's is checked: ask who we are now and take the full
    // refresh only if we are no longer signed in, since it blanks the app behind this dialog.
    onSuccess: async (_data, session) => {
      if (session.current === true || (session.current === undefined && (await signedOut()))) {
        return void (await refresh({ bootstrapLocal: false }))
      }
      await qc.invalidateQueries({ queryKey: KEY })
    },
  })
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose() }}>
      <DialogContent className="max-w-[460px] border-0" overlayClassName="bg-[var(--scrim)]" showCloseButton={false}>
        <DialogTitle>Sessions</DialogTitle>
        <DialogDescription>Browsers where you are signed in.</DialogDescription>
        <ul className="mt-3 flex max-h-[50dvh] flex-col gap-2 overflow-y-auto" data-testid="member-sessions">
          {sessions.isPending && <li className="text-[var(--text-tertiary)]">Loading…</li>}
          {sessions.isError && <li role="alert" className="text-[var(--system-red)]">Couldn&rsquo;t load your sessions.</li>}
          {sessions.data?.map((session) => (
            <li key={session.id} className="flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">
                  {label(session)}{session.current && <span className="ml-2 text-[var(--accent)]">This browser</span>}
                </div>
                <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  {session.lastSeenAt ? `Last active ${formatRelativeTime(session.lastSeenAt)}` : "Not used yet"}
                </div>
              </div>
              <Button variant="secondary" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(session)} className="rounded-full">
                {session.current ? "Sign out" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
        {revoke.isError && <div role="alert" data-testid="revoke-error" className="mt-3 text-[length:var(--text-footnote)] text-[var(--system-red)]">{accountsErrorText(revoke.error, "Couldn't end that session. Try again.")}</div>}
        <div className="mt-4 flex justify-end"><button type="button" onClick={onClose} className={DIALOG_CANCEL_CLASS}>Close</button></div>
      </DialogContent>
    </Dialog>
  )
}
