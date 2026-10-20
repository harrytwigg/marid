import { AlertTriangle } from "@/components/ui/icon"
import type { EngineLimitAccountSnapshot, EngineLimitEngineSnapshot, EngineLimitWindow } from "@/lib/api"
import { engineDisplayName } from "@/lib/engine-names"
import { accountStatus } from "./account-status"
import { agoLabel, barColor, clampPercent, resetLabel, windowLabel } from "./format"
import { deriveFreshness, type FreshnessKind } from "./use-engine-limits"

// Freshness kind → badge tone + label, evaluated at render time so a snapshot
// that ages past the freshness window flips to "Stale" without a re-fetch and a
// long-open tab can never present hours-old data as current.
function badge(kind: FreshnessKind, engine: EngineLimitEngineSnapshot, now: number) {
  switch (kind) {
    case "live":
      return { color: "var(--system-green)", label: "Live" }
    case "fresh":
      return { color: "var(--text-tertiary)", label: `Updated ${agoLabel(engine.refreshedAt, now)}` }
    case "stale":
      return { color: "var(--system-orange)", label: `Stale · ${agoLabel(engine.refreshedAt, now)}` }
    case "error":
      return { color: "var(--system-red)", label: "Error" }
    case "unavailable":
      return { color: "var(--text-tertiary)", label: "Unavailable" }
    case "unsupported":
      return { color: "var(--text-quaternary)", label: "Unsupported" }
    default:
      return { color: "var(--text-quaternary)", label: "No data" }
  }
}

// Fixed, operator-safe note per freshness kind. Deliberately does NOT render
// `engine.error` verbatim: that field can carry raw parser/exception text, so
// the client shows only allowlisted copy. `unsupportedReason` is collector-
// authored literal copy (never exception-derived) and is safe to surface.
function noteFor(engine: EngineLimitEngineSnapshot, kind: FreshnessKind): string | null {
  switch (kind) {
    case "stale":
      return engine.error
        ? "Couldn’t refresh — showing last-known values."
        : "Last-known snapshot is over 30 minutes old — may be out of date."
    case "error":
      return "Latest limits couldn’t be read."
    case "unavailable":
    case "unsupported":
      return engine.unsupportedReason ?? null
    default:
      return null
  }
}

function WindowBar({ window, now }: { window: EngineLimitWindow; now: number }) {
  const observed = window.usedPercent !== undefined
  const used = clampPercent(window.usedPercent)
  const reset = resetLabel(window.resetsAtIso, now)

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {windowLabel(window)} window
        </span>
        <span className="text-[length:var(--text-body)] font-[var(--weight-bold)] text-[var(--text-primary)] tabular-nums">
          {observed ? `${window.usedPercent}%` : "—"}
        </span>
      </div>
      <div className="mt-[var(--space-2)] h-2 rounded-full bg-[var(--fill-tertiary)] overflow-hidden">
        {observed && (
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-[var(--ease-smooth)]"
            style={{ width: `${used}%`, background: barColor(window.usedPercent) }}
          />
        )}
      </div>
      {reset && (
        <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{reset}</div>
      )}
    </div>
  )
}

interface Tone {
  color: string
  label: string
}

function creditLabelFor(engine: EngineLimitEngineSnapshot): string | null {
  const credits = engine.credits
  if (credits?.unlimited) return "Unlimited credits"
  return credits?.balance ? `Credits ${credits.balance}` : null
}

/** An account's own flags take over the badge and the note; otherwise the engine's freshness does. */
function toneAndNote(engine: EngineLimitEngineSnapshot, account: EngineLimitAccountSnapshot | undefined, now: number): { tone: Tone; note: string | null } {
  const status = account ? accountStatus(account, now) : null
  if (status) return { tone: status, note: status.note }
  const kind = deriveFreshness(engine, now).kind
  return { tone: badge(kind, engine, now), note: noteFor(engine, kind) }
}

function CardHeader({ engine, account, title, tone }: {
  engine: EngineLimitEngineSnapshot
  account?: EngineLimitAccountSnapshot
  title?: string
  tone: Tone
}) {
  const where = account?.location
  const remoteHost = where?.kind === "remote" ? where.host : null
  // An account's own label (".claude-friend", "harry@studio") is shown as written;
  // an engine's name goes through the shared display-name helper ("Muse Code",
  // "opencode") rather than a CSS `capitalize`, which mangles both.
  const label = title ?? engine.name
  const isEngineName = !title || title === engine.name
  return (
    <div className="flex items-start justify-between gap-[var(--space-3)]">
      <div className="min-w-0">
        {/* With no group headings left, a profile card names its engine above the
            profile so an account never reads as an engine of its own. */}
        {!isEngineName && (
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
            {engineDisplayName(engine.name)}
          </div>
        )}
        <div className="flex items-baseline gap-[var(--space-3)] min-w-0">
          <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">
            {isEngineName ? engineDisplayName(label) : label}
          </h2>
          {engine.accountPlan && (
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
              {engine.accountPlan}
            </span>
          )}
        </div>
        {remoteHost && (
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">on {remoteHost}</div>
        )}
      </div>
      <span className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] whitespace-nowrap">
        <span className="w-2 h-2 rounded-full" style={{ background: tone.color }} />
        {tone.label}
      </span>
    </div>
  )
}

function Windows({ engine, now }: { engine: EngineLimitEngineSnapshot; now: number }) {
  const windows = engine.windows || []
  if (windows.length === 0) {
    return (
      <div className="mt-[var(--space-6)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        No quota windows observed yet.
      </div>
    )
  }
  return (
    <div className="mt-[var(--space-6)] grid gap-[var(--space-5)]">
      {windows.map((window) => (
        <WindowBar key={`${engine.name}-${window.name}`} window={window} now={now} />
      ))}
    </div>
  )
}

/** One configured agent: an engine, or an account (engine + profile) when the
 *  engine reports several. `account` carries the per-account state and `title`
 *  its name. */
export function EngineCard({ engine, now, account, title }: {
  engine: EngineLimitEngineSnapshot
  now: number
  account?: EngineLimitAccountSnapshot
  title?: string
}) {
  const { tone, note } = toneAndNote(engine, account, now)
  const creditLabel = creditLabelFor(engine)

  return (
    // Grouped-inset card (shared visual language): --bg-secondary carrying the
    // page's only card shadow — no border at rest. `h-full` in an even-row grid
    // gives every card the same height whatever it has to say.
    <article className="glass-card flex h-full flex-col rounded-[var(--radius-xl)] p-[var(--space-6)]" data-testid="engine-card">
      <CardHeader engine={engine} account={account} title={title} tone={tone} />

      {account && account.employees.length > 0 && (
        <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Used by {account.employees.join(", ")}
        </div>
      )}

      <div className="flex-1">
        <Windows engine={engine} now={now} />
      </div>

      {creditLabel && (
        <div className="mt-[var(--space-5)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {creditLabel}
        </div>
      )}

      {note && (
        <div className="mt-[var(--space-5)] flex items-start gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          <AlertTriangle size={14} className="mt-[2px] flex-shrink-0" style={{ color: tone.color }} />
          <span>{note}</span>
        </div>
      )}
    </article>
  )
}
