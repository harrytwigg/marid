import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { accountsErrorText } from "@/components/people/errors"
import {
  accountsApi,
  BOARD_ROLES,
  BOARD_ROLE_LABEL,
  type BoardGrantWire,
  type BoardRole,
  type InstanceRole,
  type PersonWire,
} from "@/lib/accounts-api"
import { SettingsSelect } from "../shared"
import { OwnerWarning } from "./instance-invites"
import { useRefreshPeople } from "./use-people"
import { ERROR, NOTE, SUBHEAD } from "./styles"

const INSTANCE_ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "owner", label: "Owner (co-operator)" },
]
const BOARD_ROLE_OPTIONS = BOARD_ROLES.map((role) => ({ value: role, label: BOARD_ROLE_LABEL[role] }))

const PROMOTE_CLOSING = "They are signed out of their member sessions and sign in again as an operator. Only promote someone you would hand the keys to."

/** Roles on an existing account: its instance role, and its role on each board it is on. Each change applies on their next request. */
export function RolesPanel({ person }: { person: PersonWire }) {
  return (
    <div data-testid={`roles-${person.id}`} className="mt-3 flex flex-col gap-4">
      <InstanceRoleControl person={person} />
      <BoardRoleControls person={person} />
    </div>
  )
}

function InstanceRoleControl({ person }: { person: PersonWire }) {
  const refresh = useRefreshPeople()
  const [picked, setPicked] = useState<InstanceRole>(person.instanceRole)
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: (instanceRole: InstanceRole) => accountsApi.updatePerson(person.id, { instanceRole }),
    onSuccess: async (_data, instanceRole) => {
      setUnderstood(false)
      setPicked(instanceRole)
      await refresh()
    },
    onError: (e) => setError(accountsErrorText(e)),
  })
  const dirty = picked !== person.instanceRole
  const promoting = picked === "owner" && dirty
  const demoting = !promoting && dirty
  const choose = (next: InstanceRole) => { setPicked(next); setUnderstood(false); setError(null) }
  const apply = () => { setError(null); change.mutate(picked) }
  return (
    <section aria-label="Instance role" className="flex flex-col gap-2">
      <h3 className={SUBHEAD}>Instance role</h3>
      <div className="sm:w-[260px]">
        <SettingsSelect ariaLabel={`Instance role for ${person.displayName}`} value={picked} onChange={(v) => choose(v as InstanceRole)} options={INSTANCE_ROLE_OPTIONS} />
      </div>
      {promoting && <OwnerWarning testId={`promote-warning-${person.id}`} understood={understood} onChange={setUnderstood} closing={PROMOTE_CLOSING} checkLabel={`I understand ${person.displayName} becomes a co-operator.`} />}
      {demoting && (
        <p data-testid={`demote-note-${person.id}`} className={NOTE}>
          {person.displayName} stops being a co-operator. Their operator devices are signed out; they keep only the boards they were shared.
        </p>
      )}
      {error && <p role="alert" data-testid={`instance-role-error-${person.id}`} className={ERROR}>{error}</p>}
      {dirty && <ApplyRow promoting={promoting} blocked={promoting && !understood} pending={change.isPending} onApply={apply} onCancel={() => choose(person.instanceRole)} />}
    </section>
  )
}

function ApplyRow({ promoting, blocked, pending, onApply, onCancel }: { promoting: boolean; blocked: boolean; pending: boolean; onApply: () => void; onCancel: () => void }) {
  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={pending || blocked} onClick={onApply}>{pending ? "Saving…" : promoting ? "Make owner" : "Make member"}</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
    </div>
  )
}

function BoardRoleControls({ person }: { person: PersonWire }) {
  return (
    <section aria-label="Board roles" className="flex flex-col gap-2">
      <h3 className={SUBHEAD}>Boards</h3>
      {person.boards.length === 0 && <p className={NOTE}>No boards. Share a board with them from its Share button.</p>}
      {person.instanceRole === "owner" && person.boards.length > 0 && (
        <p className={NOTE}>As an instance owner they reach every board whatever these roles say.</p>
      )}
      <ul className="flex flex-col gap-2">
        {person.boards.map((grant) => <BoardRoleRow key={grant.department} person={person} grant={grant} />)}
      </ul>
    </section>
  )
}

function BoardRoleRow({ person, grant }: { person: PersonWire; grant: BoardGrantWire }) {
  const refresh = useRefreshPeople()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: (role: BoardRole) => accountsApi.setBoardRole(grant.department, person.id, role),
    onSuccess: async () => {
      // An open Share dialog for this board reads the same grant.
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["board-roster"] })])
    },
    onError: (e) => setError(accountsErrorText(e)),
  })
  return (
    <li data-testid={`board-role-${person.id}-${grant.department}`} className="flex flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">{grant.department}</span>
        <div className="w-[150px] shrink-0">
          <SettingsSelect
            ariaLabel={`Role for ${person.displayName} on ${grant.department}`}
            value={grant.role}
            onChange={(value) => { setError(null); change.mutate(value as BoardRole) }}
            options={BOARD_ROLE_OPTIONS}
          />
        </div>
      </div>
      {error && <p role="alert" className={ERROR}>{error}</p>}
    </li>
  )
}
