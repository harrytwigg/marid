import { RefreshCw } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
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
          <Button variant="ghost" size="icon-sm" aria-label="Refresh cron jobs" onClick={onRefresh} className="size-[30px] min-h-0 text-[var(--text-tertiary)]">
            <RefreshCw size={13} className={fetching ? "animate-spin" : undefined} aria-hidden />
          </Button>
        </div>
      }
    />
  )
}
