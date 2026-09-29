import { useEffect, useState, type KeyboardEvent } from "react"
import { CONTROL_CLASS, ToggleSwitch } from "@/routes/settings/shared"
import { numberFieldValue } from "./policy-model"

/**
 * The form's controls, with the one rule FR-003a sets: a toggle
 * commits on click; a text or number field commits on blur or Enter, never on
 * a keystroke. Five of the eleven fields are not safe at an intermediate value
 * (a prefix of `30` idle minutes forgets the operator after 3; `EST` is a real
 * zone on the way to `EST5EDT`), and one rule for every field beats two.
 */

export function FieldLabel({ label, hint, problem, narrow, children }: {
  label: string
  hint?: string
  /** The gateway's refusal for this field, verbatim. */
  problem?: string
  /** A short control beside the label — for the tier cards, where a
   *  full-width control would leave the label wrapping word by word. */
  narrow?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={`flex gap-[var(--space-3)] py-[var(--space-2)] ${narrow ? "flex-row items-start justify-between" : "flex-col gap-[var(--space-1)] sm:flex-row sm:items-start sm:justify-between sm:gap-[var(--space-4)]"}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">{label}</span>
        {hint && <span className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{hint}</span>}
        {problem && (
          <span role="alert" className="block text-[length:var(--text-caption1)] text-[var(--system-red)]">
            {problem}
          </span>
        )}
      </span>
      <span className={narrow ? "w-[88px] shrink-0" : "w-full sm:w-[200px] sm:shrink-0"}>{children}</span>
    </label>
  )
}

/** A text-shaped field whose typed value reaches `onCommit` on blur or Enter.
 *  Re-seeds from `value` when the policy is reloaded under it. */
export function CommitInput({ value, onCommit, type = "text", list, min, max, step, placeholder, ariaLabel, disabled }: {
  value: string
  onCommit: (raw: string) => void
  type?: "text" | "number" | "time"
  list?: string
  min?: number
  max?: number
  step?: number
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { if (draft !== value) onCommit(draft) }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); commit() }
  }
  return (
    <input
      type={type}
      value={draft}
      list={list}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className={`${CONTROL_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
    />
  )
}

/** A number field: blank or non-numeric text commits nothing and says so. */
export function NumberField({ label, hint, problem, value, onCommit, min, max, step = 1, ariaLabel, disabled, narrow }: {
  label: string
  hint?: string
  problem?: string
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  step?: number
  ariaLabel: string
  disabled?: boolean
  narrow?: boolean
}) {
  const [needsNumber, setNeedsNumber] = useState(false)
  const commit = (raw: string) => {
    const parsed = numberFieldValue(raw)
    setNeedsNumber(parsed === undefined)
    if (parsed !== undefined) onCommit(parsed)
  }
  return (
    <FieldLabel label={label} hint={hint} narrow={narrow} problem={problem ?? (needsNumber ? "needs a number — nothing was saved" : undefined)}>
      <CommitInput type="number" value={String(value)} onCommit={commit} min={min} max={max} step={step} ariaLabel={ariaLabel} disabled={disabled} />
    </FieldLabel>
  )
}

export function ToggleField({ label, hint, problem, checked, onChange, ariaLabel, disabled }: {
  label: string
  hint?: string
  problem?: string
  checked: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-[var(--space-4)] py-[var(--space-2)]">
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">{label}</span>
        {hint && <span className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{hint}</span>}
        {problem && <span role="alert" className="block text-[length:var(--text-caption1)] text-[var(--system-red)]">{problem}</span>}
      </span>
      <span className={disabled ? "opacity-50" : undefined}>
        <ToggleSwitch checked={checked} disabled={disabled} onChange={onChange} ariaLabel={ariaLabel} />
      </span>
    </div>
  )
}
