import { RefreshCw } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { Skeleton } from "@/components/ui/skeleton"
import { ConfigConflictNotice } from "@/routes/settings/config-conflict-notice"
import { ConfigSaveStatus } from "@/routes/settings/config-save-status"
import { HistoryList } from "./history-list"
import { NextTickCard } from "./next-tick-card"
import { PolicyForm } from "./policy-form"
import type { PolledReadState } from "@/hooks/use-polled-read"
import type { IdleCapacityTier, UsageSample } from "@/lib/api-idle-capacity"
import { useAutoDispatchLive, useUsageSamples, type AutoDispatchLive } from "./use-auto-dispatch"
import { UsageCard } from "./usage-card"
import { usePolicyEditor, type PolicyEditor } from "./use-policy-editor"

/**
 * Auto-Dispatch: the idle-capacity auto-start's dashboard — what the
 * next tick would do, the policy as a form, and what the loop has started.
 * The write path is use-policy-editor.ts; everything else here is read-only.
 */

function Notices({ editor, liveError }: { editor: PolicyEditor; liveError: string | null }) {
  const error = editor.error ?? liveError
  return (
    <>
      {error && (
        <div role="alert" className="rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
          {error}
        </div>
      )}
      {editor.conflict && <ConfigConflictNotice message={editor.conflict.message} remedy={editor.conflict.remedy} onReload={editor.reload} />}
    </>
  )
}

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

function Form({ editor, activeTier }: { editor: PolicyEditor; activeTier?: IdleCapacityTier }) {
  if (!editor.policy) return <Skeleton height={320} className="rounded-[var(--radius-xl)]" />
  return (
    <PolicyForm
      key={editor.seedKey ?? "unseeded"}
      policy={editor.policy}
      activeTier={activeTier}
      problems={editor.problems}
      disabled={editor.locked}
      onCommit={editor.commitField}
    />
  )
}

function Body({ live, editor, usage }: { live: PolledReadState<AutoDispatchLive>; editor: PolicyEditor; usage: PolledReadState<UsageSample[]> }) {
  if (live.phase === "loading") {
    return (
      <>
        <Skeleton height={140} className="rounded-[var(--radius-xl)]" />
        <Skeleton height={320} className="rounded-[var(--radius-xl)]" />
      </>
    )
  }
  const data: AutoDispatchLive = live.data ?? { preview: null, loopAbsent: false, history: [] }
  return (
    <>
      <NextTickCard preview={data.preview} loopAbsent={data.loopAbsent} now={live.now} />
      <UsageCard samples={usage.data} starts={data.history} preview={data.preview} policy={editor.policy} now={live.now} error={usage.error} />
      <Form editor={editor} activeTier={data.preview?.tier} />
      <HistoryList starts={data.history} now={live.now} />
    </>
  )
}

export default function AutoDispatchPage() {
  const live = useAutoDispatchLive()
  const usage = useUsageSamples()
  // The form already holds what it just wrote; only the loop's view changes.
  const editor = usePolicyEditor(live.refresh)

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="960px"
        header={
          <LargeTitleHeader
            title="Auto-Dispatch"
            subtitle="Starts backlog work on Claude capacity that would otherwise lapse"
            trailing={<RefreshButton onClick={live.refresh} busy={live.refreshing} />}
          />
        }
      >
        <div className="grid gap-[var(--space-5)]">
          <Notices editor={editor} liveError={live.error} />
          <Body live={live} editor={editor} usage={usage} />
        </div>
        <ConfigSaveStatus state={editor.saveState} />
      </PageScaffold>
    </PageLayout>
  )
}
