import type { IdleCapacityTier, IdleCapacityTierPolicy } from "@/lib/api-idle-capacity"
import { NumberField, ToggleField } from "./field"
import type { PolicyField } from "./policy-model"

const TIER_COPY: Record<IdleCapacityTier, { title: string; when: string }> = {
  overnight: { title: "Overnight", when: "Inside the quiet hours, operator not live. Spends deep; the ceiling is the floor it leaves." },
  daytime: { title: "Daytime", when: "Outside the quiet hours, operator not live. Leaves headroom for a session later." },
  interactive: { title: "Interactive", when: "The operator is live, at any hour. Barely touches the window." },
}

export function TierCard({ tier, policy, active, problems, disabled, onCommit }: {
  tier: IdleCapacityTier
  policy: IdleCapacityTierPolicy
  /** The tier the next tick would run under, per the preview. */
  active: boolean
  problems: Record<string, string>
  disabled: boolean
  onCommit: (field: PolicyField, value: unknown) => void
}) {
  const copy = TIER_COPY[tier]
  const p = (suffix: string) => problems[`tiers.${tier}.${suffix}`]
  const set = (suffix: string) => (value: unknown) => onCommit(`tiers.${tier}.${suffix}` as PolicyField, value)
  return (
    <section
      data-testid={`tier-${tier}`}
      className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-4)]"
      style={active ? { boxShadow: "inset 0 0 0 1.5px var(--accent)" } : undefined}
    >
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <h3 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{copy.title}</h3>
        {active && (
          <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--accent)]">next tick</span>
        )}
      </div>
      <p className="mt-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{copy.when}</p>
      <div className="mt-[var(--space-2)]">
        <ToggleField label="Enabled" checked={policy.enabled} onChange={set("enabled")} ariaLabel={`${copy.title} tier enabled`} problem={p("enabled")} disabled={disabled} />
        <NumberField narrow label="5h ceiling %" hint="Hold above this" value={policy.fiveHour.maxUsedPercent} onCommit={set("fiveHour.maxUsedPercent")} min={0} max={100} ariaLabel={`${copy.title} five-hour ceiling`} problem={p("fiveHour.maxUsedPercent")} disabled={disabled} />
        <NumberField narrow label="5h lookahead (min)" hint="Reset must be within" value={policy.fiveHour.lookaheadMinutes} onCommit={set("fiveHour.lookaheadMinutes")} min={1} ariaLabel={`${copy.title} five-hour lookahead`} problem={p("fiveHour.lookaheadMinutes")} disabled={disabled} />
        <NumberField narrow label="Weekly ceiling %" hint="Every weekly bucket" value={policy.sevenDay.maxUsedPercent} onCommit={set("sevenDay.maxUsedPercent")} min={0} max={100} ariaLabel={`${copy.title} weekly ceiling`} problem={p("sevenDay.maxUsedPercent")} disabled={disabled} />
        <NumberField narrow label="Weekly lookahead (min)" value={policy.sevenDay.lookaheadMinutes} onCommit={set("sevenDay.lookaheadMinutes")} min={1} ariaLabel={`${copy.title} weekly lookahead`} problem={p("sevenDay.lookaheadMinutes")} disabled={disabled} />
        <NumberField narrow label="Starts per 5h window" value={policy.maxDispatchesPerWindow} onCommit={set("maxDispatchesPerWindow")} min={1} ariaLabel={`${copy.title} starts per window`} problem={p("maxDispatchesPerWindow")} disabled={disabled} />
        <NumberField narrow label="Busy sessions allowed" hint="Hold at this many or more" value={policy.maxActiveSessions} onCommit={set("maxActiveSessions")} min={1} ariaLabel={`${copy.title} busy session limit`} problem={p("maxActiveSessions")} disabled={disabled} />
      </div>
    </section>
  )
}
