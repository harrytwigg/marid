export type SessionFallbackMode = 'fallback' | 'fallback-children' | 'auto-resume'

export interface SessionFallbackTarget {
  engine: string
  account?: string
  model?: string
  label: string
}

export interface SessionFallbackView {
  mode: SessionFallbackMode
  modeSource: 'session' | 'default'
  target: SessionFallbackTarget | null
}

export const FALLBACK_MODE_OPTIONS: ReadonlyArray<{
  mode: SessionFallbackMode
  title: string
  description: string
}> = [
  { mode: 'fallback', title: 'Fall back', description: 'Fall back on usage limit' },
  { mode: 'fallback-children', title: 'Fall back + children', description: 'Fall back, and child sessions inherit it' },
  { mode: 'auto-resume', title: 'Auto-resume', description: 'Never switch model; wait and auto-resume' },
]

/** Visible chip text. */
export function fallbackChipText(view: SessionFallbackView): string {
  if (view.mode === 'auto-resume') return 'Fallback: off (auto-resume)'
  if (!view.target) return 'Fallback: disabled'
  return `Fallback: ${view.target.label}`
}

const MODES: ReadonlyArray<string> = ['fallback', 'fallback-children', 'auto-resume']

function isTarget(t: unknown): boolean {
  if (t == null) return true
  const o = t as Record<string, unknown>
  return typeof t === 'object' && typeof o.label === 'string' && typeof o.engine === 'string'
}

/** Narrow an API value to a view, or null when the shape is not the contract's (older or newer gateway). */
export function parseFallbackView(raw: unknown): SessionFallbackView | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const okMode = typeof v.mode === 'string' && MODES.includes(v.mode)
  const okSource = v.modeSource === 'session' || v.modeSource === 'default'
  return okMode && okSource && isTarget(v.target) ? (raw as SessionFallbackView) : null
}

/** Tooltip: the visible text plus the target's engine, account and model. */
export function fallbackChipTitle(view: SessionFallbackView): string {
  const parts: string[] = [fallbackChipText(view)]
  const t = view.mode === 'auto-resume' ? null : view.target
  if (t) {
    const detail = [`engine ${t.engine}`, t.account ? `account ${t.account}` : '', t.model ? `model ${t.model}` : '']
      .filter(Boolean)
      .join(', ')
    parts.push(`(${detail})`)
  }
  if (view.mode === 'fallback-children') parts.push('· child sessions inherit it')
  return parts.join(' ')
}

/** The view after picking `mode`: the mode is now the session's own; the target is unchanged. */
export function withMode(view: SessionFallbackView, mode: SessionFallbackMode): SessionFallbackView {
  return { ...view, mode, modeSource: 'session' }
}
