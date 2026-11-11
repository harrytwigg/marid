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
  type PersonWire,
  type UserSessionWire,
} from "@/lib/accounts-api"
import { Section } from "../shared"
import { InviteToInstance, PendingInvites } from "./instance-invites"
import { RolesPanel } from "./person-roles"
import { sessionsKey, usePeople, usePendingInvites, useRefreshPeople } from "./use-people"

import { DIVIDER, ERROR, NOTE, SUBHEAD } from "./styles"

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
type Panel = "none" | "roles" | "sessions" | "rename" | "remove"

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
  const [reset, setReset] = useState<{ link: string | null; expiresAt?: string } | null>(null)
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
        <Button size="sm" variant="secondary" aria-label={label("Change roles for")} aria-expanded={panel === "roles"} onClick={() => toggle("roles")}>Roles</Button>
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
      {panel === "roles" && <RolesPanel person={person} />}
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
      <p className={NOTE}>Remove {name}? They are signed out everywhere and lose access to every board. Their Todos and comments stay, shown as a former member, and any Todo naming them as the person responsible loses its person.</p>
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
