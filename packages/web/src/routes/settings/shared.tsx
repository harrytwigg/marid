import { createContext, useContext, useId } from "react"
import { ToggleSwitch as UiToggleSwitch } from "@/components/ui/toggle-switch"

// ---------------------------------------------------------------------------
// Section wrapper using CSS variable styling
// ---------------------------------------------------------------------------

export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-7">
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] px-[var(--space-3)] pb-[var(--space-2)]"
      >
        {title}
      </div>
      {/* Grouped-inset card (shared visual language): --bg-secondary carrying
          the card shadow — no hairline ring at rest. */}
      <div
        className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-4)] shadow-[var(--shadow-card)]"
      >
        {children}
      </div>
    </section>
  )
}

// One control recipe for every text input and select on the page: soft
// --fill-tertiary well, no border at rest, accent focus ring (mirrors
// .apple-input, sized for dense form rows).
export const CONTROL_CLASS =
  "min-h-[40px] md:min-h-0 w-full rounded-[10px] border-none bg-[var(--fill-tertiary)] px-[12px] py-[7px] " +
  "text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none " +
  "placeholder:text-[var(--text-tertiary)] transition-[box-shadow] duration-150 " +
  "focus:shadow-[0_0_0_3px_var(--accent-fill)]"

/** The id a `FieldRow` puts on its label, so the control the row labels can
 *  carry the same id and the two are associated. `SettingsSelect` and
 *  `SettingsInput` take it; the settings `ToggleSwitch` does not, because the
 *  HeroUI switch already wraps its input in a label element and a second one
 *  would be two labels for the same control. */
const FieldRowControlId = createContext<string | null>(null)

function useFieldRowControlId(): string | undefined {
  return useContext(FieldRowControlId) ?? undefined
}

export function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const controlId = `field-${useId()}`
  return (
    <div
      className="flex flex-col items-stretch gap-[var(--space-2)] py-[var(--space-2)] sm:flex-row sm:items-center sm:justify-between sm:gap-[var(--space-4)]"
    >
      {/* A real label for the row's control: the control takes this id through
          the context below, so the name comes from the row and clicking the
          words focuses the field. It used to be an orphan <label> with no
          htmlFor. On a switch row the id goes unclaimed — see the context. */}
      <label
        htmlFor={controlId}
        className="shrink-0 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
      >
        {label}
      </label>
      <FieldRowControlId.Provider value={controlId}>
        <div className="min-w-0 w-full sm:w-[240px] sm:shrink-0">{children}</div>
      </FieldRowControlId.Provider>
    </div>
  )
}

export function SettingsInput({
  value,
  onChange,
  type = "text",
  placeholder,
  disabled = false,
  min,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
  min?: number
  ariaLabel?: string
}) {
  const fieldId = useFieldRowControlId()
  return (
    <input
      id={fieldId}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      aria-label={ariaLabel}
      className={`${CONTROL_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
    />
  )
}

export function SettingsSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  /** Required: a `<select>` shows only its chosen option, not what it is for, so
   *  an omitted name leaves a screen reader reading bare menu options. Optional
   *  let eight settings-page call sites ship unnamed. */
  ariaLabel: string
}) {
  const fieldId = useFieldRowControlId()
  return (
    <select
      id={fieldId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className={`${CONTROL_CLASS} cursor-pointer`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  /** Required: a `role="switch"` control carries no text of its own, so an
   *  omitted name leaves a screen reader announcing it as bare "switch".
   *  Optional let five settings-page call sites ship unnamed. */
  ariaLabel: string
  /** A switch mid-write: not clickable and not keyboard-toggleable either. */
  disabled?: boolean
}) {
  return <UiToggleSwitch checked={checked} onChange={onChange} label={ariaLabel} disabled={disabled} />
}
