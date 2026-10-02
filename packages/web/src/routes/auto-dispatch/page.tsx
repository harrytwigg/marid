import { RefreshCw } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { Skeleton } from "@/components/ui/skeleton"
import type { PolledReadState } from "@/hooks/use-polled-read"
import type { UsageSample } from "@/lib/api-auto-dispatch"
import { BoardWalkCard } from "./board-walk-card"
import { SessionsList } from "./sessions-list"
import { useAutoDispatchLive, useUsageSamples, type AutoDispatchLive } from "./use-auto-dispatch"
import { UsageCard } from "./usage-card"

/**
 * Auto-Dispatch: what the board walk is doing, where the Claude allowance is
 * heading, and every session started on each engine. Read-only — what the
 * walk may start, and when, is prose in `board-walk.md`.
 */

function RefreshButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label="Refresh"
      aria-busy={busy}
      className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
    >
      <RefreshCw size={17} className={busy ? "animate-spin" : ""} />
    </button>
  )
}

function Body({ live, usage }: { live: PolledReadState<AutoDispatchLive>; usage: PolledReadState<UsageSample[]> }) {
  if (live.phase === "loading") {
    return (
      <>
        <Skeleton height={140} className="rounded-[var(--radius-xl)]" />
        <Skeleton height={320} className="rounded-[var(--radius-xl)]" />
      </>
    )
  }
  const data: AutoDispatchLive = live.data ?? { status: null, walkAbsent: false, ticks: [], sessions: [] }
  const claudeStarts = data.sessions.filter((session) => session.engine === "claude")
  return (
    <>
      <BoardWalkCard status={data.status} ticks={data.ticks} absent={data.walkAbsent} now={live.now} />
      <UsageCard samples={usage.data} starts={claudeStarts} now={live.now} error={usage.error} />
      <SessionsList sessions={data.sessions} now={live.now} />
    </>
  )
}

export default function AutoDispatchPage() {
  const live = useAutoDispatchLive()
  const usage = useUsageSamples()

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="960px"
        header={
          <LargeTitleHeader
            title="Auto-Dispatch"
            subtitle="The board walk: what is ready, what it started, and the capacity it spends"
            trailing={<RefreshButton onClick={live.refresh} busy={live.refreshing} />}
          />
        }
      >
        <div className="grid gap-[var(--space-5)]">
          {live.error && (
            <div role="alert" className="rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
              {live.error}
            </div>
          )}
          <Body live={live} usage={usage} />
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
