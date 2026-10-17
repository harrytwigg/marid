import { ArrowRight } from "@/components/ui/icon"
import { engineLabel } from "./chain-model"

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
            {engineLabel(engine)}
          </div>
          <div className="mt-[2px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            An older setting still routes Claude here. Migrate it into the chain above.
          </div>
        </div>
        <button
          type="button"
          onClick={onMigrate}
          className="inline-flex h-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          Migrate
        </button>
      </div>
    </div>
  )
}
