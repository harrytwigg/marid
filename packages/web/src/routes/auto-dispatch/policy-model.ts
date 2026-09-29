import type { IdleCapacityPolicy, IdleCapacityTier } from "@/lib/api-idle-capacity"

/**
 * The policy as the form holds it, and the three translations around it:
 * form → the `gateway.idleCapacity` block a save writes; a field edit → the
 * next policy; the gateway's refusal → the field it names.
 *
 * There is no validator here on purpose (FR-003): the gateway's
 * `idleCapacityProblems` is the one truth, and every message it produces
 * begins with the offending key's path, which is all this side needs.
 */

/** A dotted path under `gateway.idleCapacity`, exactly as the validator spells it. */
export type PolicyField =
  | "enabled" | "intervalMinutes" | "timezone" | "requireLabel"
  | "quietHours.start" | "quietHours.end"
  | "operatorActivity.idleMinutes" | "operatorActivity.usageDeltaPercent"
  | `tiers.${IdleCapacityTier}.enabled`
  | `tiers.${IdleCapacityTier}.fiveHour.maxUsedPercent` | `tiers.${IdleCapacityTier}.fiveHour.lookaheadMinutes`
  | `tiers.${IdleCapacityTier}.sevenDay.maxUsedPercent` | `tiers.${IdleCapacityTier}.sevenDay.lookaheadMinutes`
  | `tiers.${IdleCapacityTier}.maxDispatchesPerWindow` | `tiers.${IdleCapacityTier}.maxActiveSessions`

/** The partial document `PUT /api/config` takes. Every key of the block is
 *  explicit, so the gateway's deep-merge amounts to a replace; the one `null`
 *  (no opt-in label) is how the merge removes a key. */
export function policyToConfigDocument(policy: IdleCapacityPolicy): { gateway: { idleCapacity: IdleCapacityPolicy } } {
  return {
    gateway: {
      idleCapacity: {
        ...policy,
        quietHours: { ...policy.quietHours },
        operatorActivity: { ...policy.operatorActivity },
        tiers: {
          overnight: { ...policy.tiers.overnight, fiveHour: { ...policy.tiers.overnight.fiveHour }, sevenDay: { ...policy.tiers.overnight.sevenDay } },
          daytime: { ...policy.tiers.daytime, fiveHour: { ...policy.tiers.daytime.fiveHour }, sevenDay: { ...policy.tiers.daytime.sevenDay } },
          interactive: { ...policy.tiers.interactive, fiveHour: { ...policy.tiers.interactive.fiveHour }, sevenDay: { ...policy.tiers.interactive.sevenDay } },
        },
        requireLabel: policy.requireLabel?.trim() ? policy.requireLabel.trim() : null,
      },
    },
  }
}

/** The policy with one field replaced. Structural, not typed per field: the
 *  gateway validates the value, and a wrong type there is a named refusal. */
export function setPolicyField(policy: IdleCapacityPolicy, field: PolicyField, value: unknown): IdleCapacityPolicy {
  const next = policyToConfigDocument(policy).gateway.idleCapacity as unknown as Record<string, unknown>
  const parts = field.split(".")
  let cursor: Record<string, unknown> = next
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>
  cursor[parts[parts.length - 1]] = value
  return next as unknown as IdleCapacityPolicy
}

const PROBLEM = /^gateway\.idleCapacity\.(?<field>[A-Za-z.]+) (?<message>.+)$/

/**
 * The gateway's refusal, split back onto fields. The route joins the
 * validator's problems as `Invalid config: a; b`, and each problem starts with
 * its key's path. A message that names no field (or a field this form does not
 * carry) lands under `""`, so it is still shown rather than lost.
 */
export function problemsByField(message: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = message.replace(/^Invalid config:\s*/, "")
  for (const problem of body.split(/;\s+(?=gateway\.idleCapacity\.)/)) {
    const match = PROBLEM.exec(problem.trim())
    if (match?.groups) out[match.groups.field] = match.groups.message
    else out[""] = out[""] ? `${out[""]}; ${problem.trim()}` : problem.trim()
  }
  return out
}

/** A number field's typed text as a value to save, or undefined while it is
 *  blank or not a number — nothing is written for those. */
export function numberFieldValue(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}
