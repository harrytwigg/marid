import type { ReactNode } from "react"
import { KeyRound } from "@/components/ui/icon"
import { BrandMark } from "@/components/brand-mark-image"
import { PRODUCT_NAME } from "@/lib/brand"
import { PASSWORD_MAX, PASSWORD_MIN, validatePassword } from "@/lib/accounts-api"
import { FieldLabel, inputClass, inputShell } from "./account-form-parts"

/** The card the invite and reset pages sit in: the pairing screen's frame, without its pairing copy. */
export function AccountPageFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="h-dvh overflow-y-auto bg-[var(--bg)] text-[var(--text-primary)] flex items-start sm:items-center justify-center px-[var(--space-4)] py-[max(var(--safe-top),var(--space-8))]">
      <section className="w-full max-w-[480px] glass-card rounded-[var(--radius-xl)] p-[var(--space-6)]">
        <div className="mb-[var(--space-5)] flex items-center gap-[var(--space-3)] px-[var(--space-4)]">
          <BrandMark size={44} className="shrink-0" />
          <div className="min-w-0">
            <p className="brand-wordmark text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{PRODUCT_NAME}</p>
            <h1 className="text-balance text-[length:var(--text-title3)] font-[var(--weight-semibold)] tracking-[var(--tracking-normal)]">{title}</h1>
            {subtitle && <p className="mt-1 text-pretty text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">{subtitle}</p>}
          </div>
        </div>
        {children}
      </section>
    </main>
  )
}

/** The wording a password is checked with, in one place for the invite and the reset. */
export function passwordProblem(password: string, confirm: string): string | null {
  return validatePassword(password) ?? (password !== confirm ? "The two passwords don't match." : null)
}

interface PasswordFieldsProps {
  idPrefix: string
  password: string
  confirm: string
  onPassword: (value: string) => void
  onConfirm: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
}

export function PasswordFields({ idPrefix, password, confirm, onPassword, onConfirm, disabled, invalid, describedBy }: PasswordFieldsProps) {
  return (
    <>
      <FieldLabel htmlFor={`${idPrefix}-password`}>Password</FieldLabel>
      <div className={inputShell}>
        <KeyRound size={16} className="shrink-0 text-[var(--text-tertiary)]" />
        <input
          id={`${idPrefix}-password`}
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={inputClass}
        />
      </div>
      <p className="-mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{PASSWORD_MIN} to {PASSWORD_MAX} characters.</p>
      <FieldLabel htmlFor={`${idPrefix}-confirm`}>Repeat password</FieldLabel>
      <div className={inputShell}>
        <KeyRound size={16} className="shrink-0 text-[var(--text-tertiary)]" />
        <input
          id={`${idPrefix}-confirm`}
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX}
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={inputClass}
        />
      </div>
    </>
  )
}
