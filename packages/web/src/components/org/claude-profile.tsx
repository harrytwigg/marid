import type { Employee } from "@/lib/api"

type ClaudeProfileWire = NonNullable<Employee["claudeProfile"]>

/** A profile is labelled by its directory name (`.claude-friend`), as the
 *  Limits page will label its account. */
export function claudeProfileLabel(profile: ClaudeProfileWire): string {
  const trimmed = profile.path.replace(/\/+$/, "")
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed
}

const PROFILE_TINT = {
  color: "var(--system-indigo)",
  background: "color-mix(in srgb, var(--system-indigo) 15%, transparent)",
}

/** The org tree's badge for an employee on a named Claude profile. The default
 *  profile shows none. */
export function ClaudeProfileBadge({ profile }: { profile: Employee["claudeProfile"] }) {
  if (!profile) return null
  return (
    <span
      data-testid="claude-profile-badge"
      title={`Runs on the Claude profile ${profile.path}`}
      className="max-w-[88px] whitespace-nowrap overflow-hidden text-ellipsis text-[length:var(--text-caption2)] font-[var(--weight-semibold)] py-px px-[7px] rounded-[10px]"
      style={PROFILE_TINT}
    >
      {claudeProfileLabel(profile)}
    </span>
  )
}

/** The employee panel's read-only profile row. `claudeConfigDir` is set in the
 *  employee's YAML only, so there is nothing to edit here. */
export function ClaudeProfileRow({ profile }: { profile: Employee["claudeProfile"] }) {
  if (!profile) return null
  return (
    <div data-testid="claude-profile-row" className="mt-[var(--space-4)]">
      <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
        Claude profile
      </p>
      <p className="text-[length:var(--text-body)] text-[var(--text-primary)] m-0 flex items-center gap-[var(--space-2)] min-w-0">
        <span className="font-[family-name:var(--font-mono)] whitespace-nowrap overflow-hidden text-ellipsis min-w-0">{profile.path}</span>
        <span className="shrink-0 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] py-px px-[7px] rounded-[10px]" style={PROFILE_TINT}>
          {profile.key}
        </span>
      </p>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[var(--space-1)] mb-0">
        Set by <code className="font-[family-name:var(--font-mono)]">claudeConfigDir</code> in the employee&apos;s YAML. Its sessions run on that account.
      </p>
    </div>
  )
}
