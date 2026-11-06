import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingsSelect } from "@/routes/settings/shared"
import { BOARD_ROLE_HINT, type BoardRole, type InviteResultWire } from "@/lib/accounts-api"
import { accountsErrorText } from "./errors"
import { IssuedLink } from "./issued-link"
import { endpoints, HEADING, rank, roleOptions, type ShareMode } from "./share-support"

function useBoardInvite(department: string, mode: ShareMode, ceiling: BoardRole, onSent: () => Promise<void>) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<BoardRole>("viewer")
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InviteResultWire | null>(null)
  const effectiveRole = rank(role) > rank(ceiling) ? ceiling : role
  const send = useMutation({
    mutationFn: () => endpoints(mode).invite(department, email.trim(), effectiveRole),
    onSuccess: async (res) => {
      setResult(res)
      setEmail("")
      await onSent()
    },
    onError: (e) => setError(accountsErrorText(e)),
  })
  const submit = () => {
    if (!email.trim() || send.isPending) return
    setError(null)
    setResult(null)
    send.mutate()
  }
  return { email, setEmail, role: effectiveRole, setRole, error, result, clearResult: () => setResult(null), pending: send.isPending, submit }
}

function InviteResult({ result, onDismiss }: { result: InviteResultWire | null; onDismiss: () => void }) {
  if (!result) return null
  if (result.granted === true) {
    return (
      <p role="status" data-testid="share-granted" className="mt-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        They already have an account, so they now have access. There is no link to send.
      </p>
    )
  }
  return (
    <IssuedLink
      link={result.link}
      expiresAt={result.expiresAt}
      hint="Inviting the same address again revokes this link."
      onDismiss={onDismiss}
      testId="share-link"
    />
  )
}

export function BoardInviteForm({ department, mode, ceiling, onSent }: {
  department: string
  mode: ShareMode
  ceiling: BoardRole
  onSent: () => Promise<void>
}) {
  const invite = useBoardInvite(department, mode, ceiling, onSent)
  return (
    <section aria-label="Invite" className="mt-5">
      <h3 className={HEADING}>Invite someone</h3>
      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); invite.submit() }}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            aria-label="Email"
            placeholder="name@example.com"
            autoComplete="off"
            value={invite.email}
            onChange={(e) => invite.setEmail(e.target.value)}
            className="min-h-[40px] min-w-0 flex-1 md:min-h-0"
          />
          <div className="sm:w-[150px]">
            <SettingsSelect ariaLabel="Role" value={invite.role} onChange={(v) => invite.setRole(v as BoardRole)} options={roleOptions(ceiling)} />
          </div>
          <Button type="submit" disabled={invite.pending || !invite.email.trim()}>{invite.pending ? "Inviting…" : "Invite"}</Button>
        </div>
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{BOARD_ROLE_HINT[invite.role]}</p>
      </form>
      {invite.error && <p role="alert" data-testid="share-invite-error" className="mt-2 text-[length:var(--text-footnote)] text-[var(--system-red)]">{invite.error}</p>}
      <InviteResult result={invite.result} onDismiss={invite.clearResult} />
    </section>
  )
}
