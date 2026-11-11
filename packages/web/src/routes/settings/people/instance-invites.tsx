import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { IssuedLink } from "@/components/people/issued-link"
import { accountsErrorText, formatWhen } from "@/components/people/errors"
import {
  accountsApi,
  BOARD_ROLE_LABEL,
  type InstanceRole,
  type InviteResultWire,
  type PendingInviteWire,
} from "@/lib/accounts-api"
import { SettingsSelect } from "../shared"
import { useRefreshPeople } from "./use-people"
import { ERROR, NOTE, SUBHEAD } from "./styles"

const INSTANCE_ROLES = [
  { value: "member", label: "Member (no boards until you share one)" },
  { value: "owner", label: "Owner (co-operator)" },
]

function useInstanceInvite() {
  const refresh = useRefreshPeople()
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<InstanceRole>("member")
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InviteResultWire | null>(null)
  const send = useMutation({
    mutationFn: () => accountsApi.inviteToInstance(email.trim(), role),
    onSuccess: async (res) => {
      setResult(res)
      setEmail("")
      setUnderstood(false)
      await refresh()
    },
    onError: (e) => setError(accountsErrorText(e)),
  })
  const owner = role === "owner"
  // An owner invite hands over the whole instance, so it waits for the explicit second step.
  const ready = Boolean(email.trim()) && !send.isPending && (!owner || understood)
  const submit = () => {
    if (!ready) return
    setError(null)
    setResult(null)
    send.mutate()
  }
  const chooseRole = (next: InstanceRole) => { setRole(next); setUnderstood(false) }
  return { email, setEmail, role, chooseRole, owner, understood, setUnderstood, error, result, dismiss: () => setResult(null), pending: send.isPending, ready, submit }
}

const OWNER_INVITE_CLOSING = "The link lasts 24 hours, not 7 days. Only invite someone you would hand the keys to."

/** The plain warning before anyone becomes a co-operator: sending an owner invite, or promoting an existing account. */
export function OwnerWarning({ understood, onChange, testId = "owner-invite-warning", closing = OWNER_INVITE_CLOSING, checkLabel = "I understand this person becomes a co-operator." }: {
  understood: boolean
  onChange: (value: boolean) => void
  testId?: string
  /** The sentence after the shared one, specific to how the role is being given. */
  closing?: string
  checkLabel?: string
}) {
  return (
    <div role="alert" data-testid={testId} className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-orange)_12%,transparent)] p-3">
      <p className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--system-orange)]">This makes them a co-operator.</p>
      <p className={NOTE}>
        An owner has the same authority as you over this whole instance: every board, every employee, settings, and anything that starts or spends. {closing}
      </p>
      <label className="flex items-start gap-2 text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        <input type="checkbox" checked={understood} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
        <span>{checkLabel}</span>
      </label>
    </div>
  )
}

function InstanceInviteResult({ result, onDismiss }: { result: InviteResultWire | null; onDismiss: () => void }) {
  if (!result) return null
  if (result.granted === true) {
    return <p role="status" data-testid="invite-instance-granted" className={NOTE}>They already have an account, so it was updated and there is no link to send.</p>
  }
  return <IssuedLink link={result.link} expiresAt={result.expiresAt} onDismiss={onDismiss} testId="invite-instance-link" />
}

export function InviteToInstance() {
  const invite = useInstanceInvite()
  return (
    <form
      data-testid="invite-instance"
      aria-label="Invite to the instance"
      className="flex flex-col gap-2"
      onSubmit={(event) => { event.preventDefault(); invite.submit() }}
    >
      <h3 className={SUBHEAD}>Invite to the instance</h3>
      <p className={NOTE}>An instance invite adds a person with no board. Share a board with them from its Share button, or from here once they have joined.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input type="email" aria-label="Invitee email" placeholder="name@example.com" autoComplete="off" value={invite.email} onChange={(e) => invite.setEmail(e.target.value)} className="min-h-[40px] min-w-0 flex-1 md:min-h-0" />
        <div className="sm:w-[260px]">
          <SettingsSelect ariaLabel="Instance role" value={invite.role} onChange={(v) => invite.chooseRole(v as InstanceRole)} options={INSTANCE_ROLES} />
        </div>
      </div>
      {invite.owner && <OwnerWarning understood={invite.understood} onChange={invite.setUnderstood} />}
      {invite.error && <p role="alert" data-testid="invite-instance-error" className={ERROR}>{invite.error}</p>}
      <div>
        <Button type="submit" disabled={!invite.ready}>
          {invite.pending ? "Inviting…" : invite.owner ? "Invite co-operator" : "Send invite"}
        </Button>
      </div>
      <InstanceInviteResult result={invite.result} onDismiss={invite.dismiss} />
    </form>
  )
}

// ── Pending invites ──────────────────────────────────────────────────────────
function isOwnerInvite(invite: PendingInviteWire): boolean {
  return invite.department === null && invite.instanceRole === "owner"
}

/** Owner invites lead, then the newest first. A pending co-operator invite is the one a person must not forget. */
export function sortPendingInvites(invites: readonly PendingInviteWire[]): PendingInviteWire[] {
  return [...invites].sort((a, b) => {
    const owner = Number(isOwnerInvite(b)) - Number(isOwnerInvite(a))
    return owner !== 0 ? owner : Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })
}

function scopeOf(invite: PendingInviteWire): string {
  if (invite.department === null) return `Instance · ${invite.instanceRole === "owner" ? "Owner" : "Member"}`
  return `${invite.department} · ${invite.role ? BOARD_ROLE_LABEL[invite.role] : "Viewer"}`
}

export function PendingInvites({ invites, loading, error }: { invites: PendingInviteWire[] | undefined; loading: boolean; error: unknown }) {
  const refresh = useRefreshPeople()
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: (id: string) => accountsApi.revokeInvite(id),
    onSuccess: refresh,
    onError: (e) => setRevokeError(accountsErrorText(e)),
  })
  const rows = sortPendingInvites(invites ?? [])
  return (
    <div data-testid="pending-invites">
      <h3 className={SUBHEAD}>Pending invites</h3>
      {loading && <p className={NOTE}>Loading…</p>}
      {error != null && <p role="alert" className={ERROR}>{accountsErrorText(error, "Couldn't load invites.")}</p>}
      {!loading && error == null && rows.length === 0 && <p className={NOTE}>No invites are waiting.</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((invite) => {
          const owner = isOwnerInvite(invite)
          return (
            <li
              key={invite.id}
              data-testid={`pending-invite-${invite.id}`}
              data-owner-invite={owner ? "true" : undefined}
              className={`flex items-center gap-2 rounded-[var(--radius-md)] p-3 ${owner ? "bg-[color-mix(in_srgb,var(--system-orange)_12%,transparent)] shadow-[inset_0_0_0_1px_var(--system-orange)]" : "bg-[var(--fill-quaternary)]"}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {owner && <Badge variant="warning">Co-operator invite</Badge>}
                  <span className="break-all text-[length:var(--text-subheadline)] text-[var(--text-primary)]">{invite.email}</span>
                </div>
                <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{scopeOf(invite)} · expires {formatWhen(invite.expiresAt)}</div>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Revoke invite for ${invite.email}`} disabled={revoke.isPending} onClick={() => { setRevokeError(null); revoke.mutate(invite.id) }}>Revoke</Button>
            </li>
          )
        })}
      </ul>
      {revokeError && <p role="alert" className={ERROR}>{revokeError}</p>}
    </div>
  )
}
