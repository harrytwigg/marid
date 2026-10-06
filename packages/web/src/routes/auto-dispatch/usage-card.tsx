import { OptionPills } from "@/components/ui/option-pills"
import type { StartedSession, UsageAccountOption, UsageSample } from "@/lib/api-auto-dispatch"
import { UsageChart } from "./usage-chart"
import { projectWindow, readout, weeklyVerdicts, type Projection } from "./usage-projection"

/**
 * The usage card (US4). The weekly verdict leads — "will the week's allowance
 * run out before the weekly reset, at a glance" — over every weekly bucket,
 * worst first; the five-hour projection and the graph are the detail beneath
 * it. No gates are drawn: what counts as "too full to start" is prose in the
 * board walk's rules, not a number the page can know.
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
      {item(<span className="inline-block size-[10px] rounded-full bg-[var(--system-green)]" />, "board walk start")}
      {item(<span className="inline-block size-[8px] rounded-full bg-[var(--text-tertiary)]" />, "other session start")}
      {item(<span className="inline-block h-3 w-[1px] bg-[var(--text-quaternary)]" />, "window reset")}
    </div>
  )
}

function Headline({ verdicts }: { verdicts: Array<{ name: string; projection: Projection }> }) {
  const lead = verdicts[0]
  return (
    <div data-testid="usage-headline">
      <p className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] leading-snug text-[var(--text-primary)]">
        {lead ? readout(lead.projection, { window: lead.name }) : "Weekly: no reading with a reset yet"}
      </p>
      {verdicts.slice(1).map((verdict) => (
        <p key={verdict.name} className="mt-[var(--space-1)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {readout(verdict.projection, { window: verdict.name })}
        </p>
      ))}
    </div>
  )
}

/** The Claude accounts to pick between, which the card shows only when there is more than one. */
export interface AccountSwitch {
  accounts: UsageAccountOption[]
  account: string
  onSelect: (account: string) => void
}

export function UsageCard({ samples, starts, now, error, switcher }: {
  samples: UsageSample[] | null
  /** Sessions started on Claude, whatever started them. */
  starts: StartedSession[]
  now: number
  error: string | null
  switcher?: AccountSwitch
}) {
  const all = samples ?? []
  const fiveHour = projectWindow(all, "5h", now)
  const weekly = weeklyVerdicts(all, now)
  const label = switcher?.accounts.find((option) => option.account === switcher.account)?.label
  return (
    <section data-testid="usage" className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-5)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-[var(--space-3)] gap-y-[var(--space-2)]">
        <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          Where the Claude allowance is heading{label ? ` — ${label}` : ""}
        </h2>
        {switcher && (
          <OptionPills
            label="Claude account"
            options={switcher.accounts.map((option) => ({ value: option.account, label: option.label }))}
            selected={switcher.account}
            onSelect={switcher.onSelect}
          />
        )}
      </div>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">A straight line through this window's readings, nothing cleverer.</p>
      {error && <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]">{error}</p>}
      <div className="mt-[var(--space-3)]">
        <Headline verdicts={weekly} />
        <p data-testid="usage-five-hour" className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {readout(fiveHour, { window: "5h" })}
        </p>
      </div>
      <div className="mt-[var(--space-4)]">
        <UsageChart samples={all} starts={starts} projection={fiveHour} now={now} />
      </div>
      <Legend />
    </section>
  )
}
