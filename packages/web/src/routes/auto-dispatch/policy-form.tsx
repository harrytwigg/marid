import { useMemo } from "react"
import { IDLE_CAPACITY_TIERS, type IdleCapacityPolicy, type IdleCapacityTier } from "@/lib/api-idle-capacity"
import { Section } from "@/routes/settings/shared"
import { CommitInput, FieldLabel, NumberField, ToggleField } from "./field"
import type { PolicyField } from "./policy-model"
import { TierCard } from "./tier-card"

const ZONE_LIST_ID = "auto-dispatch-timezones"

/** The runtime's zone names for the datalist, where the browser offers them. */
function knownTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.("timeZone") ?? []
  } catch {
    return []
  }
}

interface SectionProps {
  policy: IdleCapacityPolicy
  problems: Record<string, string>
  disabled: boolean
  onCommit: (field: PolicyField, value: unknown) => void
}

function GeneralSection({ policy, problems, disabled, onCommit }: SectionProps) {
  const zones = useMemo(knownTimezones, [])
  return (
    <Section title="Policy">
      {problems[""] && (
        <p role="alert" className="mb-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]">{problems[""]}</p>
      )}
      <ToggleField
        label="Auto-start on spare capacity"
        hint="Off by default. On, the loop reads the account's real Claude windows every few minutes and starts backlog work when one is about to lapse."
        checked={policy.enabled}
        onChange={(value) => onCommit("enabled", value)}
        ariaLabel="Idle-capacity auto-start enabled"
        problem={problems.enabled}
        disabled={disabled}
      />
      <NumberField label="Check every (min)" hint="How often the reading is re-taken" value={policy.intervalMinutes} onCommit={(v) => onCommit("intervalMinutes", v)} min={1} ariaLabel="Check interval minutes" problem={problems.intervalMinutes} disabled={disabled} />
      <FieldLabel label="Time zone" hint="The quiet hours are read in this zone" problem={problems.timezone}>
        <CommitInput value={policy.timezone} onCommit={(v) => onCommit("timezone", v)} list={zones.length ? ZONE_LIST_ID : undefined} placeholder="Europe/London" ariaLabel="Quiet-hours time zone" disabled={disabled} />
        {zones.length > 0 && (
          <datalist id={ZONE_LIST_ID}>
            {zones.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
        )}
      </FieldLabel>
      <FieldLabel label="Quiet hours start" hint="The overnight tier applies from here" problem={problems["quietHours.start"]}>
        <CommitInput type="time" value={policy.quietHours.start} onCommit={(v) => onCommit("quietHours.start", v)} ariaLabel="Quiet hours start" disabled={disabled} />
      </FieldLabel>
      <FieldLabel label="Quiet hours end" hint="May wrap midnight" problem={problems["quietHours.end"]}>
        <CommitInput type="time" value={policy.quietHours.end} onCommit={(v) => onCommit("quietHours.end", v)} ariaLabel="Quiet hours end" disabled={disabled} />
      </FieldLabel>
      <FieldLabel label="Opt-in label" hint="Set one and only backlog Todos carrying it are eligible; empty means every Todo that has not opted out" problem={problems.requireLabel}>
        <CommitInput value={policy.requireLabel ?? ""} onCommit={(v) => onCommit("requireLabel", v.trim() ? v.trim() : null)} placeholder="none" ariaLabel="Opt-in label" disabled={disabled} />
      </FieldLabel>
    </Section>
  )
}

function OperatorSection({ policy, problems, disabled, onCommit }: SectionProps) {
  return (
    <Section title="Operator detection">
      <NumberField label="Counts as live for (min)" hint="After the last sign of the operator" value={policy.operatorActivity.idleMinutes} onCommit={(v) => onCommit("operatorActivity.idleMinutes", v)} min={1} ariaLabel="Operator idle minutes" problem={problems["operatorActivity.idleMinutes"]} disabled={disabled} />
      <NumberField label="Usage rising by (%)" hint="Five-hour usage rising this much between two checks, while no Marid session ran, is the operator" value={policy.operatorActivity.usageDeltaPercent} onCommit={(v) => onCommit("operatorActivity.usageDeltaPercent", v)} min={1} max={100} step={0.5} ariaLabel="Operator usage delta percent" problem={problems["operatorActivity.usageDeltaPercent"]} disabled={disabled} />
    </Section>
  )
}

/**
 * Every key of `gateway.idleCapacity` as a control (FR-002). The form
 * holds no validation and no defaults: the values arrive resolved from the
 * gateway, and a refusal arrives from the gateway with the field it names.
 */
export function PolicyForm({ activeTier, ...section }: SectionProps & {
  /** The tier the next tick would run under, per the preview. */
  activeTier?: IdleCapacityTier
}) {
  return (
    <div data-testid="policy-form" aria-busy={section.disabled}>
      <GeneralSection {...section} />
      <OperatorSection {...section} />
      <Section title="Tiers">
        <div className="grid gap-[var(--space-3)] md:grid-cols-3">
          {IDLE_CAPACITY_TIERS.map((tier) => (
            <TierCard key={tier} tier={tier} policy={section.policy.tiers[tier]} active={activeTier === tier} problems={section.problems} disabled={section.disabled} onCommit={section.onCommit} />
          ))}
        </div>
      </Section>
    </div>
  )
}
