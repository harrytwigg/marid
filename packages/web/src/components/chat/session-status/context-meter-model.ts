import { fmtK, formatContextUsage, type ContextUsage } from '@/lib/context-usage'
import type { ContextUsageWire } from '@/lib/api-context-usage'

/** What the ring shows. `hidden` renders nothing at all. */
export type ContextMeterModel =
  | { kind: 'hidden' }
  | { kind: 'unknown'; tooltip: string }
  | { kind: 'known'; usage: ContextUsage; percent: string; tooltip: string }

/** The tokens the meter shows: the live figure while a turn streams, else the fetched one. */
export function shownTokens(
  data: ContextUsageWire | undefined,
  liveTokens: number | null | undefined,
): number | null {
  if (liveTokens != null && liveTokens > 0) return liveTokens
  return data?.contextTokens ?? null
}

/** The enabled auto-compact budget, or null when auto-compaction is off or unbudgeted. */
export function enabledBudget(data: ContextUsageWire | undefined): number | null {
  return data?.autoCompact.enabled ? (data.autoCompact.budgetTokens ?? null) : null
}

function modelName(data: ContextUsageWire): string {
  return data.modelLabel ?? data.model ?? data.engine
}

function tooltipFor(data: ContextUsageWire, tokens: number | null, usage: ContextUsage | null): string {
  const name = modelName(data)
  if (tokens != null && usage) return `${usage.label} tokens · ${name}`
  if (tokens != null) return `${fmtK(tokens)} tokens · ${name}`
  return `Context size unknown · ${name}`
}

/**
 * Decide the ring. Unknown tokens or an unknown window draw the empty "n/a"
 * ring; if the engine also cannot compact, there is nothing to show or do, so
 * the meter disappears.
 */
export function contextMeterModel(
  data: ContextUsageWire | undefined,
  liveTokens: number | null | undefined,
): ContextMeterModel {
  if (!data) return { kind: 'hidden' }
  const tokens = shownTokens(data, liveTokens)
  const usage = tokens == null ? null : formatContextUsage(tokens, data.contextWindow, enabledBudget(data))
  if (tokens == null || !usage) {
    if (tokens == null && data.compact.reason?.code === 'unsupported') return { kind: 'hidden' }
    return { kind: 'unknown', tooltip: tooltipFor(data, tokens, usage) }
  }
  return {
    kind: 'known',
    usage,
    percent: `${Math.round(usage.rawPct * 100)}%`,
    tooltip: tooltipFor(data, tokens, usage),
  }
}

export const BUSY_MESSAGE = 'The session is busy; compact when the turn has finished.'

/** Local clock time of an ISO instant ("14:32"), or null when it does not parse. */
export function localRetryTime(iso: string | undefined): string | null {
  if (!iso) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Why "Compact now" is disabled, or null when it can be pressed. A running
 * turn in this pane wins over the gateway's answer, which may be a beat stale.
 */
export function compactDisabledReason(data: ContextUsageWire, loading: boolean): string | null {
  if (loading) return BUSY_MESSAGE
  const { available, reason, retryAt } = data.compact
  if (available) return null
  const message = reason?.message ?? 'Compaction is not available right now.'
  const at = reason?.code === 'cooldown' ? localRetryTime(retryAt) : null
  return at ? `${message} Available again at ${at}.` : message
}
