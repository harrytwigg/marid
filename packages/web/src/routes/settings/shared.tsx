import { ChevronDownIcon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
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
      {/* Glass card on the reading sheet (glass-identity.css): tint, lit edge, no blur. */}
      <div className="glass-card rounded-[var(--radius-xl)] p-[var(--space-4)]">
        {children}
      </div>
    </section>
  )
}

/** The field's phone floor: a thumb needs 40px, and from md up the field's own 34px does. */
export const FIELD_CLASS = "min-h-[40px] md:min-h-0"

export function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex flex-col items-stretch gap-[var(--space-2)] py-[var(--space-2)] sm:flex-row sm:items-center sm:justify-between sm:gap-[var(--space-4)]"
    >
      <label
        className="shrink-0 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
      >
        {label}
      </label>
      <div className="min-w-0 w-full sm:w-[240px] sm:shrink-0">{children}</div>
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
  return (
    <Input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      aria-label={ariaLabel}
      className={FIELD_CLASS}
    />
  )
}

export function SettingsSelect({
  value,
  onChange,
  options,
  ariaLabel,
  onBlur,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  ariaLabel?: string
  onBlur?: () => void
}) {
  return (
    <span className="relative block w-full">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-label={ariaLabel}
        className="select__trigger min-h-[40px] w-full cursor-pointer appearance-none pe-8 text-[length:var(--text-footnote)] md:min-h-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {/* The chevron sits over the select, so a press on it must reach the select; HeroUI pads the end only for an indicator inside the trigger, hence `pe-8` above. */}
      <ChevronDownIcon aria-hidden className="select__indicator pointer-events-none size-4" />
    </span>
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
  ariaLabel?: string
  /** A switch mid-write: not clickable and not keyboard-toggleable either. */
  disabled?: boolean
}) {
  return <UiToggleSwitch checked={checked} onChange={onChange} label={ariaLabel} disabled={disabled} />
}
