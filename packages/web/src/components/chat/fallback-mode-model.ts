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

/** Visible chip text: the full label, and a short form for narrow composers. */
export function fallbackChipText(view: SessionFallbackView): { full: string; short: string } {
  if (view.mode === 'auto-resume') return { full: 'Fallback: off (auto-resume)', short: 'off' }
  if (!view.target) return { full: 'Fallback: disabled', short: 'disabled' }
  return { full: `Fallback: ${view.target.label}`, short: view.target.label }
}

/** Tooltip: the visible text plus the target's engine, account and model. */
export function fallbackChipTitle(view: SessionFallbackView): string {
  const parts: string[] = [fallbackChipText(view).full]
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
