import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react"
import { AccountsError, describeWait } from "@/lib/accounts-api"

/** The generic sentence for a link that cannot be used. One text for expired, used, revoked and missing, so a
 *  link never says which. */
export const LINK_UNUSABLE = "This link has expired or was already used"

export const inputShell =
  "flex h-12 w-full items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 shadow-[inset_0_0_0_1px_var(--separator)] transition-[box-shadow] duration-150 [transition-timing-function:var(--ease-smooth)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-fill)] sm:h-11"
export const inputClass =
  "min-w-0 flex-1 bg-transparent text-[length:var(--text-body)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
export const submitClass =
  "mt-[var(--space-2)] inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] px-[var(--space-4)] text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-[transform,filter,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] hover:brightness-[1.04] active:scale-[0.96] disabled:opacity-55 disabled:hover:brightness-100 disabled:active:scale-100"

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]" htmlFor={htmlFor}>
      {children}
    </label>
  )
}

export function ErrorBanner({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} role="alert" aria-live="polite" className="animate-auth-reveal rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_12%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
      {children}
    </div>
  )
}

export function waitSentence(seconds: number): string {
  return `Too many attempts. Try again in ${describeWait(seconds)}.`
}

/** A wait counted down once a second, for a 429's Retry-After. `seconds` is 0 when nothing is being waited on. */
export function useWaitCountdown() {
  const [seconds, setSeconds] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current)
    timer.current = null
  }, [])
  const start = useCallback((total: number) => {
    stop()
    setSeconds(total)
    timer.current = setInterval(() => {
      setSeconds((current) => {
        if (current <= 1) {
          stop()
          return 0
        }
        return current - 1
      })
    }, 1000)
  }, [stop])
  useEffect(() => stop, [stop])
  return { seconds, start }
}

/** A rate limit with no Retry-After still blocks briefly rather than inviting a retry loop. */
export const DEFAULT_WAIT_SECONDS = 30

export function isRateLimited(error: unknown): error is AccountsError {
  return error instanceof AccountsError && error.status === 429
}

interface AccountFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  id: string
  label: string
  icon?: ReactNode
  /** The id of the error banner the field is described by, while one shows. */
  errorId?: string
  invalid?: boolean
}

/** A labelled input in the pairing screen's field shell. */
export function AccountField({ id, label, icon, errorId, invalid, ...input }: AccountFieldProps) {
  return (
    <>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className={inputShell}>
        {icon}
        <input id={id} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} className={inputClass} {...input} />
      </div>
    </>
  )
}
