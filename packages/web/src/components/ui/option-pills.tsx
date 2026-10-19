/** A one-of-N choice, sized for a handful of options and for a thumb. Labels are
 *  author-supplied and can run long, so a pill wraps inside the column it is in
 *  rather than growing past it. */
export function OptionPills({
  label,
  options,
  selected,
  disabled = false,
  className,
  onSelect,
}: {
  label: string
  options: { value: string; label: string }[]
  selected: string
  disabled?: boolean
  className?: string
  onSelect: (value: string) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex flex-wrap gap-1.5${className ? ` ${className}` : ""}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === selected}
          disabled={disabled}
          onClick={() => onSelect(option.value)}
          className={`focus-outline min-h-9 max-w-full break-words rounded-full px-3 py-1.5 text-left text-[length:var(--text-footnote)] font-[var(--weight-medium)] outline-none transition-colors disabled:opacity-50 ${
            option.value === selected
              ? "bg-[var(--accent-fill)] text-[var(--accent)]"
              : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
