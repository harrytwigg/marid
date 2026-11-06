import { useState, type FormEvent } from "react"
import { AccountPageFrame, passwordProblem, PasswordFields } from "@/components/auth/account-page-parts"
import { ErrorBanner, LINK_UNUSABLE, submitClass } from "@/components/auth/account-form-parts"
import { AuthStateIcon, AuthStateLabel } from "@/components/auth/auth-motion"
import { useLinkFlow } from "@/components/auth/use-link-flow"
import { Check } from "@/components/ui/icon"
import { gatewayTransport } from "@/lib/gateway-transport"
import { accountsApi, type ResetInspectWire } from "@/lib/accounts-api"

export default function ResetPage() {
  const flow = useLinkFlow(accountsApi.inspectReset)
  const { phase } = flow

  if (phase.kind === "loading") {
    return (
      <AccountPageFrame title="Checking your link">
        <p role="status" className="px-[var(--space-4)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Checking this link...</p>
      </AccountPageFrame>
    )
  }
  if (phase.kind === "unusable") {
    return (
      <AccountPageFrame title="Reset password">
        <ErrorBanner>{LINK_UNUSABLE}</ErrorBanner>
      </AccountPageFrame>
    )
  }
  if (phase.kind === "failed") {
    return (
      <AccountPageFrame title="Reset password">
        <div className="flex flex-col gap-[var(--space-3)]">
          <ErrorBanner>{flow.failedText}</ErrorBanner>
          <button type="button" onClick={() => void flow.retry()} disabled={flow.retryBlocked} className={submitClass}>
            Try again
          </button>
        </div>
      </AccountPageFrame>
    )
  }
  return <ResetForm info={phase.info} submit={flow.submit} />
}

function ResetForm({ info, submit }: { info: ResetInspectWire; submit: (run: (token: string) => Promise<unknown>) => Promise<string | null> }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const problem = passwordProblem(password, confirm)
  const message = failure ?? (attempted ? problem : null)

  async function complete(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setAttempted(true)
    if (problem) return
    setBusy(true)
    setFailure(null)
    const error = await submit((token) => accountsApi.completeReset(token, password))
    if (error) {
      setFailure(error)
      setBusy(false)
      return
    }
    gatewayTransport().navigate(gatewayTransport().httpUrl("/"))
  }

  return (
    <AccountPageFrame title="Choose a new password" subtitle={info.email}>
      <form onSubmit={complete} aria-label="Reset password" noValidate className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-4)]">
        <PasswordFields
          idPrefix="jinn-reset"
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          disabled={busy}
          invalid={Boolean(message)}
          describedBy={message ? "jinn-reset-error" : undefined}
        />
        {message && <ErrorBanner id="jinn-reset-error">{message}</ErrorBanner>}
        <button type="submit" disabled={busy} aria-label={busy ? "Saving your password" : "Set password"} className={submitClass}>
          <AuthStateIcon busy={busy} idleIcon={Check} size={16} />
          <AuthStateLabel busy={busy} idle="Set password" busyText="Saving..." className="min-w-[7rem]" />
        </button>
      </form>
    </AccountPageFrame>
  )
}
