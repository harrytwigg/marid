import { useState, type FormEvent } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { IssuedLink } from "@/components/people/issued-link"
import { accountsErrorText, formatWhen } from "@/components/people/errors"
import {
  accountsApi,
  BOARD_ROLE_LABEL,
  validatePassword,
  type InstanceRole,
  type InviteResultWire,
  type PendingInviteWire,
  type PersonWire,
  type UserSessionWire,
} from "@/lib/accounts-api"
import { Section, SettingsSelect } from "../shared"
import { sessionsKey, usePeople, usePendingInvites, useRefreshPeople } from "./use-people"

const SUBHEAD = "pb-2 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]"
const NOTE = "text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
const ERROR = "mt-2 text-[length:var(--text-footnote)] text-[var(--system-red)]"
const DIVIDER = "mt-5 border-t border-[var(--separator)] pt-5"

export function PeopleSection() {
  const people = usePeople()
  const invites = usePendingInvites()
  const list = people.data ?? []
  // The operator can sign in by email once an active owner account exists; until then the card offers to make theirs.
  const needsOwnSignIn = people.isSuccess && !list.some((person) => person.instanceRole === "owner" && person.status === "active")

  return (
    <Section title="People">
      <div data-testid="people-section">
        {needsOwnSignIn && <SetupOwnSignIn />}

        <div className={needsOwnSignIn ? DIVIDER : ""}>
          <h3 className={SUBHEAD}>Accounts</h3>
          {people.isPending && <p className={NOTE}>Loading…</p>}
          {people.isError && <p role="alert" className={ERROR}>{accountsErrorText(people.error, "Couldn't load people.")}</p>}
          {people.isSuccess && list.length === 0 && <p className={NOTE}>No accounts yet. Invite someone below, or set up your own sign-in.</p>}
          <ul className="flex flex-col gap-2">
            {list.map((person) => <PersonRow key={person.id} person={person} />)}
          </ul>
        </div>

        <div className={DIVIDER}>
          <InviteToInstance />
        </div>

        <div className={DIVIDER}>
          <PendingInvites invites={invites.data} loading={invites.isPending} error={invites.isError ? invites.error : null} />
        </div>
      </div>
    </Section>
  )
}

// ── Set up my sign-in ────────────────────────────────────────────────────────
function SetupOwnSignIn() {
  const refresh = useRefreshPeople()
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const setup = useMutation({
    mutationFn: () => accountsApi.setupOwnSignIn({ email: email.trim(), displayName: displayName.trim(), password }),
    onSuccess: async () => {
      setPassword("")
      setConfirm("")
      await refresh()
    },
    onError: (e) => setError(accountsErrorText(e)),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = validatePassword(password) ?? (password !== confirm ? "The two passwords don't match." : null)
    if (problem) return setError(problem)
    setError(null)
    setup.mutate()
  }
  return (
    <form onSubmit={submit} data-testid="setup-own-sign-in" aria-label="Set up my sign-in" className="flex flex-col gap-2">
      <h3 className={SUBHEAD}>Set up my sign-in</h3>
      <p className={NOTE}>
        Make an account for yourself so this browser, and any other, can sign in with an email and password instead of a pairing code. Pairing keeps working.
      </p>
      <Input type="email" aria-label="Your email" placeholder="you@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="min-h-[40px] md:min-h-0" />
      <Input aria-label="Your display name" placeholder="Display name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="min-h-[40px] md:min-h-0" />
      <Input type="password" aria-label="Password" placeholder="Password (12–256 characters)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-[40px] md:min-h-0" />
      <Input type="password" aria-label="Repeat password" placeholder="Repeat password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="min-h-[40px] md:min-h-0" />
      {error && <p role="alert" className={ERROR}>{error}</p>}
      <div>
        <Button type="submit" disabled={setup.isPending || !email.trim() || !displayName.trim() || !password}>
          {setup.isPending ? "Setting up…" : "Set up sign-in"}
        </Button>
      </div>
    </form>
  )
}

// ── One person ───────────────────────────────────────────────────────────────
type Panel = "none" | "sessions" | "rename" | "remove"

function usePersonWrites(person: PersonWire, onError: (message: string) => void, onRenamed: () => void) {
  const refresh = useRefreshPeople()
  const fail = (e: unknown) => onError(accountsErrorText(e))
  return {
    issue: useMutation({ mutationFn: () => accountsApi.issueResetLink(person.id), onError: fail }),
    toggleStatus: useMutation({
      mutationFn: () => accountsApi.updatePerson(person.id, { status: person.status === "active" ? "disabled" : "active" }),
      onSuccess: refresh,
      onError: fail,
    }),
    rename: useMutation({
      mutationFn: (displayName: string) => accountsApi.updatePerson(person.id, { displayName }),
      onSuccess: async () => { onRenamed(); await refresh() },
      onError: fail,
    }),
    remove: useMutation({ mutationFn: () => accountsApi.deletePerson(person.id), onSuccess: refresh, onError: fail }),
  }
}

function PersonRow({ person }: { person: PersonWire }) {
  const [panel, setPanel] = useState<Panel>("none")
  const [error, setError] = useState<string | null>(null)
  const [reset, setReset] = useState<{ link: string; expiresAt?: string } | null>(null)
  const writes = usePersonWrites(person, setError, () => setPanel("none"))
  const toggle = (next: Panel) => setPanel((current) => (current === next ? "none" : next))
  const run = (start: () => void) => { setError(null); start() }
  const disabled = person.status === "disabled"
  const label = (action: string) => `${action} ${person.displayName}`

  return (
    <li data-testid={`person-${person.id}`} className="rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-3">
      <PersonSummary person={person} />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" aria-label={label("Issue reset link for")} disabled={writes.issue.isPending}
          onClick={() => run(() => { setReset(null); writes.issue.mutate(undefined, { onSuccess: (res) => setReset({ link: res.link, expiresAt: res.expiresAt }) }) })}>Reset link</Button>
        <Button size="sm" variant="secondary" aria-label={label("Sessions for")} aria-expanded={panel === "sessions"} onClick={() => toggle("sessions")}>Sessions</Button>
        <Button size="sm" variant="secondary" aria-label={label("Rename")} aria-expanded={panel === "rename"} onClick={() => toggle("rename")}>Rename</Button>
        <Button size="sm" variant="secondary" aria-label={label(disabled ? "Enable" : "Disable")} disabled={writes.toggleStatus.isPending}
          onClick={() => run(() => writes.toggleStatus.mutate())}>{disabled ? "Enable" : "Disable"}</Button>
        <Button size="sm" variant="ghost" aria-label={label("Remove")} aria-expanded={panel === "remove"} onClick={() => toggle("remove")}>Remove</Button>
      </div>
      {error && <p role="alert" data-testid={`person-error-${person.id}`} className={ERROR}>{error}</p>}
      {reset && <IssuedLink link={reset.link} expiresAt={reset.expiresAt} onDismiss={() => setReset(null)} testId={`reset-link-${person.id}`} />}
      {panel === "rename" && (
        <RenameForm current={person.displayName} pending={writes.rename.isPending} onSave={(name) => run(() => writes.rename.mutate(name))} onCancel={() => setPanel("none")} />
      )}
      {panel === "remove" && (
        <RemoveConfirm name={person.displayName} pending={writes.remove.isPending} onConfirm={() => run(() => writes.remove.mutate())} onCancel={() => setPanel("none")} />
      )}
      {panel === "sessions" && <SessionsPanel person={person} onError={(e) => setError(accountsErrorText(e))} />}
    </li>
  )
}

function PersonSummary({ person }: { person: PersonWire }) {
  const disabled = person.status === "disabled"
  return (
    <div className="flex items-start gap-3">
      <HumanAvatar name={person.displayName} initials={person.initials} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">{person.displayName}</span>
          {person.instanceRole === "owner"
            ? <Badge variant="warning" data-testid={`person-role-${person.id}`}>Instance owner</Badge>
            : <Badge variant="secondary" data-testid={`person-role-${person.id}`}>Member</Badge>}
          <Badge variant={disabled ? "destructive" : "success"} data-testid={`person-status-${person.id}`}>{disabled ? "Disabled" : "Active"}</Badge>
        </div>
        <div className="break-all text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{person.email}</div>
        <BoardChips person={person} />
        {person.passwordSet === false && (
          <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--system-orange)]">No password set yet. Issue a reset link so they can choose one.</p>
        )}
        {person.lastSeenAt !== undefined && (
          <p className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">Last seen {formatWhen(person.lastSeenAt)}</p>
        )}
      </div>
    </div>
  )
}

function BoardChips({ person }: { person: PersonWire }) {
  return (
    <ul aria-label={`Boards for ${person.displayName}`} className="mt-1.5 flex flex-wrap gap-1.5">
      {person.boards.length === 0
        ? <li className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">No boards</li>
        : person.boards.map((grant) => (
          <li key={grant.department}><Badge variant="secondary">{grant.department} · {BOARD_ROLE_LABEL[grant.role]}</Badge></li>
        ))}
    </ul>
  )
}

function RenameForm({ current, pending, onSave, onCancel }: { current: string; pending: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(current)
  return (
    <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()) }}>
      <Input aria-label="Display name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="min-h-[40px] min-w-0 flex-1 md:min-h-0" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !name.trim()}>Save</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function RemoveConfirm({ name, pending, onConfirm, onCancel }: { name: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alert" className="mt-3 flex flex-col gap-2 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] p-3">
      <p className={NOTE}>Remove {name}? They are signed out everywhere and lose access to every board. Their Todos and comments stay, shown as a former member.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={pending} onClick={onConfirm}>Remove person</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function describeSession(session: UserSessionWire): string {
  const agent = session.userAgent?.trim()
  return agent ? agent : session.kind === "device" ? "Operator device" : "Browser"
}

function SessionsPanel({ person, onError }: { person: PersonWire; onError: (error: unknown) => void }) {
  const refresh = useRefreshPeople()
  const sessions = useQuery({ queryKey: sessionsKey(person.id), queryFn: () => accountsApi.listPersonSessions(person.id) })
  const revokeOne = useMutation({ mutationFn: (sid: string) => accountsApi.revokePersonSession(person.id, sid), onSuccess: refresh, onError })
  const revokeAll = useMutation({ mutationFn: () => accountsApi.revokeAllPersonSessions(person.id), onSuccess: refresh, onError })
  const rows = sessions.data ?? []
  return (
    <div data-testid={`sessions-${person.id}`} className="mt-3 flex flex-col gap-2">
      {sessions.isPending && <p className={NOTE}>Loading sessions…</p>}
      {sessions.isError && <p role="alert" className={ERROR}>{accountsErrorText(sessions.error, "Couldn't load sessions.")}</p>}
      {sessions.isSuccess && rows.length === 0 && <p className={NOTE}>No active sessions.</p>}
      {rows.map((session) => (
        <div key={session.id} data-testid={`session-${session.id}`} className="flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-footnote)] text-[var(--text-primary)]">
              <Badge variant="secondary">{session.kind === "device" ? "Device" : "Member"}</Badge>
              <span className="truncate">{describeSession(session)}</span>
            </div>
            <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Last seen {formatWhen(session.lastSeenAt)}{session.ip ? ` · ${session.ip}` : ""}</div>
          </div>
          <Button size="sm" variant="ghost" aria-label={`Revoke session ${session.id}`} disabled={revokeOne.isPending} onClick={() => revokeOne.mutate(session.id)}>Revoke</Button>
        </div>
      ))}
      {rows.length > 1 && (
        <div><Button size="sm" variant="secondary" disabled={revokeAll.isPending} onClick={() => revokeAll.mutate()}>Revoke all sessions</Button></div>
      )}
    </div>
  )
}

// ── Invite to the instance ───────────────────────────────────────────────────
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

function OwnerWarning({ understood, onChange }: { understood: boolean; onChange: (value: boolean) => void }) {
  return (
    <div role="alert" data-testid="owner-invite-warning" className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-orange)_12%,transparent)] p-3">
      <p className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--system-orange)]">This makes them a co-operator.</p>
      <p className={NOTE}>
        An owner has the same authority as you over this whole instance: every board, every employee, settings, and anything that starts or spends. The link
        lasts 24 hours, not 7 days. Only invite someone you would hand the keys to.
      </p>
      <label className="flex items-start gap-2 text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        <input type="checkbox" checked={understood} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
        <span>I understand this person becomes a co-operator.</span>
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

function InviteToInstance() {
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

function PendingInvites({ invites, loading, error }: { invites: PendingInviteWire[] | undefined; loading: boolean; error: unknown }) {
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
