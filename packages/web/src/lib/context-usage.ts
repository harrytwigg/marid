/**
 * The one rule for turning "tokens used / window" into a label, a fill and a
 * threshold colour. The model picker's context bar and the composer's context
 * meter both read it, so the two never disagree about what "nearly full" means.
 */

/** Round a token count to a compact string (23148 → "23k", 980 → "980", 1_048_576 → "1M"). */
export function fmtK(n: number): string {
  if (n >= 1_000_000) return `${String(Math.round(n / 100_000) / 10)}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Fraction of the window at which the meter turns amber / red. */
export const CONTEXT_WARN_PCT = 0.75
export const CONTEXT_DANGER_PCT = 0.9
/** Fraction of an enabled auto-compact budget at which the meter turns amber. */
export const CONTEXT_BUDGET_WARN_PCT = 0.9

export interface ContextUsage {
  /** Tokens used on the most recent turn (0 for a fresh chat). */
  tokens: number
  /** The model's context window in tokens. */
  window: number
  /** Fraction full, clamped to [0,1] for the bar. */
  pct: number
  /** Raw (un-clamped) fraction, for the tooltip percentage. */
  rawPct: number
  /** True when the turn exceeded the window. */
  over: boolean
  /** Threshold colour (orange ≥75% of the window or ≥90% of the budget, red ≥90%/over), else undefined. */
  color?: string
  /** Compact "23k / 200k" label (">200k / 200k" when over). */
  label: string
}

function thresholdColor(pct: number, tokens: number, budget: number | null | undefined): string | undefined {
  if (pct >= CONTEXT_DANGER_PCT) return 'var(--system-red)'
  const nearBudget = !!budget && budget > 0 && tokens >= budget * CONTEXT_BUDGET_WARN_PCT
  return pct >= CONTEXT_WARN_PCT || nearBudget ? 'var(--system-orange)' : undefined
}

/**
 * Pure formatting for the context meters. Returns null only when the window is
 * unknown; a null/0 token count is a valid fresh-chat state (tokens 0). The
 * optional `budget` is an enabled auto-compact budget: nearing it is a warning
 * even while the window still has room.
 */
export function formatContextUsage(
  contextTokens: number | null | undefined,
  window: number | null | undefined,
  budget?: number | null,
): ContextUsage | null {
  if (!window || window <= 0) return null
  const tokens = contextTokens && contextTokens > 0 ? contextTokens : 0
  const rawPct = tokens / window
  const pct = Math.min(rawPct, 1)
  const over = tokens > window
  const color = thresholdColor(pct, tokens, budget)
  const label = over ? `>${fmtK(window)} / ${fmtK(window)}` : `${fmtK(tokens)} / ${fmtK(window)}`
  return { tokens, window, pct, rawPct, over, color, label }
}
