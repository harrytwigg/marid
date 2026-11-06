import { useCallback, useEffect, useState } from "react"
import { AccountsError, takeFragmentToken } from "@/lib/accounts-api"
import { DEFAULT_WAIT_SECONDS, isRateLimited, LINK_UNUSABLE, useWaitCountdown, waitSentence } from "./account-form-parts"

export type LinkPhase<T> =
  | { kind: "loading" }
  | { kind: "unusable" }
  | { kind: "ready"; info: T }
  | { kind: "failed"; message: string; limited?: boolean }

/** What the invite and reset pages share: read the fragment token once (clearing it from the address bar
 *  before anything renders), inspect it, and word whatever goes wrong. `submit` runs the accept or complete
 *  call and reports a failure as text for the form to show. */
export function useLinkFlow<T>(inspect: (token: string) => Promise<T>) {
  // The initializer runs once per mount, so the token is read and cleared exactly once.
  const [token] = useState(takeFragmentToken)
  const [phase, setPhase] = useState<LinkPhase<T>>(token ? { kind: "loading" } : { kind: "unusable" })
  const wait = useWaitCountdown()

  const load = useCallback(async () => {
    if (!token) return
    setPhase({ kind: "loading" })
    try {
      setPhase({ kind: "ready", info: await inspect(token) })
    } catch (error) {
      if (error instanceof AccountsError && error.status === 410) setPhase({ kind: "unusable" })
      else if (isRateLimited(error)) {
        wait.start(error.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS)
        setPhase({ kind: "failed", message: "", limited: true })
      } else setPhase({ kind: "failed", message: error instanceof Error && error.message ? error.message : "Couldn't check this link." })
    }
    // `inspect` is a stable module function at both call sites.
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  /** Runs the final call; resolves to an error sentence, or null when it succeeded. A 410 reads as an unusable link. */
  const submit = useCallback(async (run: (token: string) => Promise<unknown>): Promise<string | null> => {
    if (!token) return LINK_UNUSABLE
    try {
      await run(token)
      return null
    } catch (error) {
      if (error instanceof AccountsError && error.status === 410) return LINK_UNUSABLE
      if (isRateLimited(error)) return waitSentence(error.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS)
      return error instanceof Error && error.message ? error.message : "Something went wrong. Try again."
    }
  }, [token])

  const failedText = phase.kind === "failed"
    ? (phase.limited ? (wait.seconds > 0 ? waitSentence(wait.seconds) : "You can try again now.") : phase.message)
    : null

  return { phase, failedText, retryBlocked: wait.seconds > 0, retry: load, submit }
}
