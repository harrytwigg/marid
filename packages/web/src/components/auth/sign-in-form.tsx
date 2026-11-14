import { useState, type FormEvent } from "react"
import { KeyRound, Mail } from "@/components/ui/icon"
import { AccountsError } from "@/lib/accounts-api"
import { AuthStateIcon, AuthStateLabel } from "./auth-motion"
import {
  AccountField,
  DEFAULT_WAIT_SECONDS,
  ErrorBanner,
  isRateLimited,
  submitClass,
  useWaitCountdown,
  waitSentence,
} from "./account-form-parts"

/** What the person is told when sign-in fails. A 401 carries one fixed sentence for an unknown email, a wrong
 *  password and a disabled account alike; nothing here may tell them apart. */
const GENERIC_FAILURE = "Email or password is incorrect"

function failureText(error: unknown): string {
  if (error instanceof AccountsError && error.status === 401) return GENERIC_FAILURE
  return error instanceof Error && error.message ? error.message : "Sign-in failed. Try again."
}

function useSignIn(onSignIn: (email: string, password: string) => Promise<void>) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const wait = useWaitCountdown()
  const waiting = wait.seconds > 0
  const ready = Boolean(email.trim() && password) && !busy && !waiting

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setFailure(null)
    try {
      await onSignIn(email.trim(), password)
      setBusy(false)
    } catch (error) {
      if (isRateLimited(error)) wait.start(error.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS)
      else setFailure(failureText(error))
      setBusy(false)
    }
  }

  return { email, setEmail, password, setPassword, busy, ready, submit, message: waiting ? waitSentence(wait.seconds) : failure }
}

export function SignInForm({ onSignIn }: { onSignIn: (email: string, password: string) => Promise<void> }) {
  const form = useSignIn(onSignIn)
  const shared = { disabled: form.busy, invalid: Boolean(form.message), errorId: "hundredfold-signin-error" }
  return (
    <form
      onSubmit={form.submit}
      aria-label="Sign in"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-4)]"
    >
      <AccountField
        {...shared}
        id="hundredfold-signin-email"
        label="Email"
        icon={<Mail size={16} className="shrink-0 text-[var(--text-tertiary)]" />}
        type="email"
        name="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={form.email}
        onChange={(e) => form.setEmail(e.target.value)}
      />
      <AccountField
        {...shared}
        id="hundredfold-signin-password"
        label="Password"
        icon={<KeyRound size={16} className="shrink-0 text-[var(--text-tertiary)]" />}
        type="password"
        name="password"
        autoComplete="current-password"
        value={form.password}
        onChange={(e) => form.setPassword(e.target.value)}
      />

      {form.message && <ErrorBanner id="hundredfold-signin-error">{form.message}</ErrorBanner>}

      <button type="submit" disabled={!form.ready} aria-label={form.busy ? "Signing in" : "Sign in"} className={submitClass}>
        <AuthStateIcon busy={form.busy} idleIcon={KeyRound} size={16} />
        <AuthStateLabel busy={form.busy} idle="Sign in" busyText="Signing in..." className="min-w-[6.75rem]" />
      </button>
    </form>
  )
}
