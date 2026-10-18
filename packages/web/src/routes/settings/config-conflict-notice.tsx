import { RotateCcw } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"

/**
 * config.yaml moved under an open page.
 *
 * Deliberately not the error toast every other failed save gets: nothing went
 * wrong with this save, it simply has not happened yet, and the operator's own
 * terminal edit is the reason. So it reads as a state with a way out — reload,
 * which re-reads the file and adopts its revision — rather than as a failure.
 */
export function ConfigConflictNotice({ message, remedy, onReload }: {
  message: string
  remedy?: string
  onReload: () => void
}) {
  return (
    <div
      data-config-conflict
      className="mb-[var(--space-4)] flex flex-col items-start gap-[var(--space-2)] rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)]"
      style={{
        background: "color-mix(in srgb, var(--system-orange) 8%, transparent)",
        color: "var(--system-orange)",
      }}
    >
      <span>{message}</span>
      {remedy && <span className="text-[var(--text-secondary)]">{remedy}</span>}
      <Button variant="secondary" size="sm" aria-label="Reload config" onClick={onReload}>
        <RotateCcw size={15} aria-hidden />
        Reload
      </Button>
    </div>
  )
}
