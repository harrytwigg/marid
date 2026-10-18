import { RefreshCw } from "@/components/ui/icon"
import { LargeTitleHeader } from "@/components/shell/large-title-header"

export function CronListHeader({
  subtitle,
  updatedAgo,
  fetching,
  onRefresh,
}: {
  subtitle: string
  updatedAgo: string | null
  fetching: boolean
  onRefresh: () => void
}) {
  return (
    <LargeTitleHeader
      title="Cron"
      subtitle={subtitle}
      trailing={
        <div className="flex items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
          {updatedAgo && <span>Updated {updatedAgo}</span>}
          <button
            type="button"
            aria-label="Refresh cron jobs"
            onClick={onRefresh}
            className="grid size-[30px] place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)]"
          >
            <RefreshCw size={13} className={fetching ? "animate-spin" : undefined} aria-hidden />
          </button>
        </div>
      }
    />
  )
}
