import { useEffect, useState, type ReactNode } from "react"
import { getAuthState, logoutBrowser } from "@/lib/auth"
import { AccountPageFrame } from "./account-page-parts"
import { ErrorBanner, submitClass } from "./account-form-parts"

/* A browser holding a board member's session cannot use the public account forms: the gateway answers
 * their sign-in, invite and reset calls with 403, because those routes are outside what a member may call.
 * So a person who arrives on one of those pages already signed in is told so and offered the way out,
 * before the form can fail on them. */

/** The sentence and the sign-out button. `onSignedOut` runs once the gateway has ended the session. */
export function SignedInNotice({ name, onSignOut }: { name: string; onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signOut() {
    setBusy(true)
    setFailed(false)
    try {
      await onSignOut()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-3)]" data-testid="signed-in-notice">
      <p className="px-[var(--space-4)] text-pretty text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
        You&rsquo;re signed in as {name}. Sign out to continue.
      </p>
      {failed && <ErrorBanner>Couldn&rsquo;t sign out. Try again.</ErrorBanner>}
      <button type="button" data-testid="signed-in-sign-out" disabled={busy} onClick={() => void signOut()} className={submitClass}>
        {busy ? "Signing out..." : "Sign out"}
      </button>
    </div>
  )
}

/** The page frame around the notice, for the screens that have nothing else to show. */
export function SignedInPage({ name, onSignOut }: { name: string; onSignOut: () => Promise<void> }) {
  return (
    <AccountPageFrame title="Already signed in">
      <SignedInNotice name={name} onSignOut={onSignOut} />
    </AccountPageFrame>
  )
}

type Who = { kind: "loading" } | { kind: "member"; name: string } | { kind: "clear" }

/** Who this browser is, asked once. The invite and reset pages sit outside the auth provider, so they ask
 *  for themselves. A gateway that cannot be asked counts as nobody: the page then behaves as it always did. */
function useWho(): [Who, () => void] {
  const [who, setWho] = useState<Who>({ kind: "loading" })
  useEffect(() => {
    let live = true
    getAuthState()
      .then((state) => {
        if (!live) return
        const principal = state.principal
        setWho(principal?.kind === "member" ? { kind: "member", name: principal.user.displayName } : { kind: "clear" })
      })
      .catch(() => live && setWho({ kind: "clear" }))
    return () => { live = false }
  }, [])
  return [who, () => setWho({ kind: "clear" })]
}

/** Mounts its children only for a browser that is not signed in as a member. The children read the link's
 *  token when they mount, so a member signs out first and the token is still in the address when they do. */
export function SignedInGate({ children }: { children: ReactNode }) {
  const [who, cleared] = useWho()
  if (who.kind === "loading") {
    return (
      <AccountPageFrame title="One moment">
        <p role="status" className="px-[var(--space-4)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">Checking...</p>
      </AccountPageFrame>
    )
  }
  if (who.kind === "member") {
    return <SignedInPage name={who.name} onSignOut={async () => { await logoutBrowser(); cleared() }} />
  }
  return <>{children}</>
}
