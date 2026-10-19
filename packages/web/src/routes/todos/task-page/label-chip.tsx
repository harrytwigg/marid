import type { WorkItemLabelWire } from "@/lib/api"

/* Todos v2 slice 6 — the label chip, and the one × the task page uses to drop
 * a value. The chip introduced that ×; the properties rail and the chip cluster
 * now clear an assignee with the same affordance, so it lives here rather than
 * three times over. Geometry is the caller's (`className`); the ink is not. */

export function RemoveButton({
  label,
  onClick,
  testId,
  className,
}: {
  label: string
  onClick: () => void
  testId?: string
  className?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onClick}
      className={`focus-outline grid place-items-center rounded-full text-[var(--text-quaternary)] outline-none hover:text-[var(--text-secondary)] ${className ?? ""}`}
    >
      ×
    </button>
  )
}

export function LabelChip({ label, onRemove }: { label: WorkItemLabelWire; onRemove?: () => void }) {
  return (
    <span className="flex h-[22px] items-center gap-[5px] rounded-[11px] bg-[var(--fill-tertiary)] px-[9px] text-[11.5px] font-medium text-[var(--text-secondary)]">
      <span className="size-[5px] rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
      {label.name}
      {onRemove && <RemoveButton label={`Remove label ${label.name}`} onClick={onRemove} className="-mr-1 size-4" />}
    </span>
  )
}
