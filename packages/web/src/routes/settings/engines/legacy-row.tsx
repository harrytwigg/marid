import { ArrowRight } from "@/components/ui/icon"
import { engineDisplayName } from "@/lib/engine-names"
import { Button } from "@/components/ui/button"

/** The deprecated `sessions.rateLimitStrategy` / `sessions.fallbackEngine` pair,
 *  read-only: the chains above are the current spelling, and editing the old one
 *  in two places would let them disagree. Migrating is the only thing to do with
 *  it, so that is the only control. */
export function LegacyFallbackRow({ engine, onMigrate }: { engine: string; onMigrate: () => void }) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-3)]">
      <div className="flex flex-col gap-[var(--space-2)] sm:flex-row sm:items-center sm:justify-between sm:gap-[var(--space-3)]">
        <div className="min-w-0">
          <div className="flex items-center gap-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]">
            Claude
            <ArrowRight size={13} aria-hidden className="shrink-0 text-[var(--text-quaternary)]" />
            {engineDisplayName(engine)}
          </div>
          <div className="mt-[2px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            An older setting still routes Claude here. Migrate it into the chain above.
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onMigrate}>
          Migrate
        </Button>
      </div>
    </div>
  )
}
