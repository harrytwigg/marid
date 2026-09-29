import type { IdleCapacityPreview, IdleCapacityWindowReading } from "@/lib/api-idle-capacity"
import { agoLabel, clampPercent, formatMinutes, operatorSignalCopy } from "./format"

/**
 * What the next tick would do and why — the auto-start preview, rendered. It is
 * the loop's own reasoning (`GET /api/idle-capacity` shares the tick's guards),
 * so what the operator reads here is what a tick would have said.
 */

function WindowRow({ window, ceiling }: { window: IdleCapacityWindowReading; ceiling: number }) {
  const over = window.usedPercent > ceiling
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-[var(--space-3)] text-[length:var(--text-footnote)]">
        <span className="text-[var(--text-secondary)]">{window.name}</span>
        <span className="tabular-nums text-[var(--text-primary)] font-[var(--weight-semibold)]">
          {window.usedPercent}%
          <span className="ml-[var(--space-2)] font-normal text-[var(--text-tertiary)]">resets in {formatMinutes(window.minutesToReset)}</span>
        </span>
      </div>
      <div className="relative mt-[var(--space-1)] h-2 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
        <div className="h-full rounded-full" style={{ width: `${clampPercent(window.usedPercent)}%`, background: over ? "var(--system-red)" : "var(--accent)" }} />
        <div aria-hidden className="absolute top-0 h-full w-[2px] bg-[var(--text-tertiary)]" style={{ left: `${clampPercent(ceiling)}%` }} title={`${ceiling}% ceiling`} />
      </div>
    </div>
  )
}

const CARD = "rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-5)] shadow-[var(--shadow-card)]"

function evidenceCopy(preview: IdleCapacityPreview, now: number): string {
  if (!preview.operator.live) return preview.quietHours ? "operator not live, inside the quiet hours" : "operator not live, outside the quiet hours"
  const when = preview.operator.seenAt ? `, ${agoLabel(preview.operator.seenAt, now)}` : ""
  return `operator live — ${operatorSignalCopy(preview.operator.source)}${when}`
}

function WindowRows({ preview }: { preview: IdleCapacityPreview }) {
  const { verdict, policy, tier } = preview
  if (!verdict || (!verdict.fiveHour && verdict.weekly.length === 0)) return null
  const rules = policy.tiers[tier]
  return (
    <div className="mt-[var(--space-4)] grid gap-[var(--space-3)]">
      {verdict.fiveHour && <WindowRow window={verdict.fiveHour} ceiling={rules.fiveHour.maxUsedPercent} />}
      {verdict.weekly.map((window) => <WindowRow key={window.name} window={window} ceiling={rules.sevenDay.maxUsedPercent} />)}
    </div>
  )
}

function Counts({ preview }: { preview: IdleCapacityPreview }) {
  const cap = preview.policy.tiers[preview.tier].maxDispatchesPerWindow
  const skipped = preview.skipped.length > 0 ? ` · ${preview.skipped.length} skipped` : ""
  return (
    <p className="mt-[var(--space-4)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      {preview.startedThisWindow} of {cap} starts used this five-hour window · {preview.eligible.length} eligible{skipped}
    </p>
  )
}

export function NextTickCard({ preview, loopAbsent, now }: { preview: IdleCapacityPreview | null; loopAbsent: boolean; now: number }) {
  if (loopAbsent || !preview) {
    return (
      <section data-testid="next-tick" className={`${CARD} text-[length:var(--text-footnote)] text-[var(--text-secondary)]`}>
        {loopAbsent ? "The idle-capacity loop is not running in this gateway." : "Reading the loop…"}
      </section>
    )
  }
  const on = preview.policy.enabled
  return (
    <section data-testid="next-tick" className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-2)]">
        <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Next tick</h2>
        <span className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          <span className="h-2 w-2 rounded-full" style={{ background: on ? "var(--system-green)" : "var(--text-quaternary)" }} />
          {on ? `on · ${preview.tier} tier` : "off"}
        </span>
      </div>
      <p className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-primary)]">{preview.reason}</p>
      <p className="mt-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{evidenceCopy(preview, now)}</p>
      <WindowRows preview={preview} />
      <Counts preview={preview} />
    </section>
  )
}
