import { RefreshCw } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { Skeleton } from "@/components/ui/skeleton"
import { EngineCards } from "./account-cards"
import { useEngineLimits } from "./use-engine-limits"

export default function LimitsPage() {
  const { data, phase, refreshing, error, now, refresh } = useEngineLimits()

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="840px"
        header={
          <LargeTitleHeader
            title="Limits"
            subtitle="Engine usage windows and quotas"
            trailing={
              <Button variant="ghost" size="icon" onClick={refresh} aria-label="Refresh engine limits" aria-busy={refreshing}>
                <RefreshCw size={17} className={refreshing ? "animate-spin" : ""} />
              </Button>
            }
          />
        }
      >
        <div>

          {error && (
            <div
              className="mb-5 rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              {data ? `Couldn’t refresh — showing last-known values. (${error})` : error}
            </div>
          )}

          {phase === "loading" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Skeleton height={180} className="rounded-[var(--radius-xl)]" />
              <Skeleton height={180} className="rounded-[var(--radius-xl)]" />
            </div>
          ) : (
            <EngineCards data={data} now={now} />
          )}
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
