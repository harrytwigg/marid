import type { IdleCapacityPolicy, IdleCapacityPreview, IdleCapacityStart, UsageSample } from "@/lib/api-idle-capacity"
import { UsageChart } from "./usage-chart"
import { projectWindow, readout, weeklyVerdicts, type Projection } from "./usage-projection"

/**
 * The usage card (US4). The weekly verdict leads — the operator's
 * stated purpose is "will the week's allowance run out before the weekly
 * reset, at a glance" — over every weekly bucket, worst first; the five-hour
 * projection and the graph are the detail beneath it. The ceilings drawn and
 * named are those of the tier the preview currently reports, so they follow
 * the preview and can switch while the operator watches.
 */

function Legend() {
  const item = (mark: React.ReactNode, label: string) => (
    <span className="inline-flex items-center gap-[6px]">{mark}{label}</span>
  )
  return (
    <div className="mt-[var(--space-2)] flex flex-wrap gap-x-[var(--space-4)] gap-y-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      {item(<span className="inline-block h-[2px] w-4 rounded bg-[var(--accent)]" />, "5h used")}
      {item(<span className="inline-block h-[2px] w-4 rounded bg-[var(--text-quaternary)]" />, "weekly buckets")}
      {item(<span className="inline-block h-[2px] w-4 rounded border-t-2 border-dashed border-[var(--accent)]" />, "projection")}
      {item(<span className="inline-block h-[2px] w-4 rounded bg-[var(--system-orange)]" />, "tier start gate")}
      {item(<span className="inline-block size-[10px] rounded-full bg-[var(--system-green)]" />, "auto-start")}
      {item(<span className="inline-block h-3 w-[1px] bg-[var(--text-quaternary)]" />, "window reset")}
    </div>
  )
}

function Headline({ verdicts, tier, ceiling }: { verdicts: Array<{ name: string; projection: Projection }>; tier: string; ceiling: number }) {
  const lead = verdicts[0]
  return (
    <div data-testid="usage-headline">
      <p className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] leading-snug text-[var(--text-primary)]">
        {lead ? readout(lead.projection, { window: lead.name, tier, ceiling }) : "Weekly: no reading with a reset yet"}
      </p>
      {verdicts.slice(1).map((verdict) => (
        <p key={verdict.name} className="mt-[var(--space-1)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {readout(verdict.projection, { window: verdict.name, tier, ceiling })}
        </p>
      ))}
    </div>
  )
}

/** The gates the graph draws: the tier the preview reports, or — with no
 *  preview (no loop in this gateway) — the daytime tier of the policy the
 *  form holds, which is the gateway's resolved policy, never a copy of the
 *  defaults; nothing to draw while neither has loaded. */
function gates(preview: IdleCapacityPreview | null, policy: IdleCapacityPolicy | null): { tier: string; fiveHour?: number; weekly?: number } {
  const tier = preview?.tier ?? "daytime"
  const rules = (preview?.policy ?? policy)?.tiers[tier]
  return { tier, fiveHour: rules?.fiveHour.maxUsedPercent, weekly: rules?.sevenDay.maxUsedPercent }
}

export function UsageCard({ samples, starts, preview, policy, now, error }: {
  samples: UsageSample[] | null
  starts: IdleCapacityStart[]
  preview: IdleCapacityPreview | null
  policy: IdleCapacityPolicy | null
  now: number
  error: string | null
}) {
  const { tier, fiveHour: fiveHourCeiling = 100, weekly: weeklyCeiling = 100 } = gates(preview, policy)
  const all = samples ?? []
  const fiveHour = projectWindow(all, "5h", fiveHourCeiling, now)
  const weekly = weeklyVerdicts(all, weeklyCeiling, now)
  return (
    <section data-testid="usage" className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-5)] shadow-[var(--shadow-card)]">
      <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Where the allowance is heading</h2>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Gates are the {tier} tier's, per the next tick; a straight line, nothing cleverer.</p>
      {error && <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]">{error}</p>}
      <div className="mt-[var(--space-3)]">
        <Headline verdicts={weekly} tier={tier} ceiling={weeklyCeiling} />
        <p data-testid="usage-five-hour" className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {readout(fiveHour, { window: "5h", tier, ceiling: fiveHourCeiling })}
        </p>
      </div>
      <div className="mt-[var(--space-4)]">
        <UsageChart samples={all} starts={starts} projection={fiveHour} ceiling={fiveHourCeiling} now={now} />
      </div>
      <Legend />
    </section>
  )
}
