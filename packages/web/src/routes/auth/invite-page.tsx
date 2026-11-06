import { useEffect, useState, type FormEvent } from "react"
import { AccountPageFrame, passwordProblem, PasswordFields } from "@/components/auth/account-page-parts"
import { AccountField, ErrorBanner, LINK_UNUSABLE, submitClass } from "@/components/auth/account-form-parts"
import { AuthStateIcon, AuthStateLabel } from "@/components/auth/auth-motion"
import { useLinkFlow } from "@/components/auth/use-link-flow"
import { SignedInGate } from "@/components/auth/signed-in-notice"
import { Check, User } from "@/components/ui/icon"
import { gatewayTransport } from "@/lib/gateway-transport"
import { accountsApi, BOARD_ROLE_HINT, BOARD_ROLE_LABEL, forgetFragmentToken, takeFragmentToken, type InviteInspectWire } from "@/lib/accounts-api"
import { PRODUCT_NAME } from "@/lib/brand"

const NAME_MAX = 80

function headline(info: InviteInspectWire): string {
  return info.boardName ? `You're invited to ${info.boardName}` : `You're invited to ${PRODUCT_NAME}`
}

export default function InvitePage() {
  // Read and cleared from the address bar at once, before the gate asks who is signed in; kept for the flow.
  const [token] = useState(takeFragmentToken)
  useEffect(() => forgetFragmentToken, [])
  return <SignedInGate><InviteFlow token={token} /></SignedInGate>
}

function InviteFlow({ token }: { token: string | null }) {
  const flow = useLinkFlow(accountsApi.inspectInvite, token)
  const { phase } = flow

  if (phase.kind === "loading") {
    return (
      <AccountPageFrame title="Checking your invite">
        <p role="status" className="px-[var(--space-4)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Checking this link...</p>
      </AccountPageFrame>
    )
  }
  if (phase.kind === "unusable") {
    return (
      <AccountPageFrame title="Invite link">
        <ErrorBanner>{LINK_UNUSABLE}</ErrorBanner>
      </AccountPageFrame>
    )
  }
  if (phase.kind === "failed") {
    return (
      <AccountPageFrame title="Invite link">
        <div className="flex flex-col gap-[var(--space-3)]">
          <ErrorBanner>{flow.failedText}</ErrorBanner>
          <button type="button" onClick={() => void flow.retry()} disabled={flow.retryBlocked} className={submitClass}>
            Try again
          </button>
        </div>
      </AccountPageFrame>
    )
  }
  return <InviteForm info={phase.info} submit={flow.submit} />
}

const NAME_PROBLEM = {
  empty: "Enter your name.",
  long: `Use at most ${NAME_MAX} characters for your name.`,
} as const

function nameProblem(name: string): string | null {
  if (!name) return NAME_PROBLEM.empty
  return name.length > NAME_MAX ? NAME_PROBLEM.long : null
}

type Submit = (run: (token: string) => Promise<unknown>) => Promise<string | null>

function useAcceptForm(submit: Submit) {
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const name = displayName.trim()
  const problem = nameProblem(name) ?? passwordProblem(password, confirm)

  async function accept(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setAttempted(true)
    if (problem) return
    setBusy(true)
    setFailure(null)
    const error = await submit((token) => accountsApi.acceptInvite(token, name, password))
    if (error) {
      setFailure(error)
      setBusy(false)
      return
    }
    // A full load, so the app reads who it is from the gateway afresh and the member shell takes over.
    gatewayTransport().navigate(gatewayTransport().httpUrl("/"))
  }

  return { displayName, setDisplayName, password, setPassword, confirm, setConfirm, busy, accept, message: failure ?? (attempted ? problem : null) }
}

function InviteForm({ info, submit }: { info: InviteInspectWire; submit: Submit }) {
  const form = useAcceptForm(submit)
  const errorId = "jinn-invite-error"
  return (
    <AccountPageFrame title={headline(info)} subtitle={info.invitedBy ? `Invited by ${info.invitedBy}` : undefined}>
      {info.boardName && info.role && (
        <p className="mb-[var(--space-3)] px-[var(--space-4)] text-pretty text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          You'll join as <strong>{BOARD_ROLE_LABEL[info.role]}</strong>. {BOARD_ROLE_HINT[info.role]}
        </p>
      )}
      <form onSubmit={form.accept} aria-label="Accept invite" noValidate className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-4)]">
        <AccountField id="jinn-invite-email" label="Email" type="email" value={info.email} readOnly autoComplete="username" />
        <AccountField
          id="jinn-invite-name"
          label="Your name"
          icon={<User size={16} className="shrink-0 text-[var(--text-tertiary)]" />}
          type="text"
          autoComplete="name"
          maxLength={NAME_MAX}
          value={form.displayName}
          onChange={(e) => form.setDisplayName(e.target.value)}
          disabled={form.busy}
          invalid={Boolean(form.message)}
          errorId={errorId}
        />
        <PasswordFields
          idPrefix="jinn-invite"
          password={form.password}
          confirm={form.confirm}
          onPassword={form.setPassword}
          onConfirm={form.setConfirm}
          disabled={form.busy}
          invalid={Boolean(form.message)}
          describedBy={form.message ? errorId : undefined}
        />

        {form.message && <ErrorBanner id={errorId}>{form.message}</ErrorBanner>}

        <button type="submit" disabled={form.busy} aria-label={form.busy ? "Creating your account" : "Create account"} className={submitClass}>
          <AuthStateIcon busy={form.busy} idleIcon={Check} size={16} />
          <AuthStateLabel busy={form.busy} idle="Create account" busyText="Creating..." className="min-w-[8rem]" />
        </button>
      </form>
    </AccountPageFrame>
  )
}
