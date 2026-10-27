import type { SelectorValue } from '@/components/chat/model-selector-row'

// Where the engine/model/effort a new chat will be created with is remembered
// between visits. Reading it back is defensive on purpose: the value is
// operator-editable storage, so a field that is not a string is treated as
// absent rather than handed on as one.
const NEW_SESSION_SELECTOR_KEY = 'jinn-chat-new-session-selector'

export function readNewSessionSelector(): SelectorValue {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(NEW_SESSION_SELECTOR_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SelectorValue
    return {
      engine: typeof parsed.engine === 'string' ? parsed.engine : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      effortLevel: typeof parsed.effortLevel === 'string' ? parsed.effortLevel : undefined,
      profile: typeof parsed.profile === 'string' ? parsed.profile : undefined,
    }
  } catch {
    return {}
  }
}

export function writeNewSessionSelector(value: SelectorValue): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(NEW_SESSION_SELECTOR_KEY, JSON.stringify({
    engine: value.engine,
    model: value.model,
    effortLevel: value.effortLevel,
    profile: value.profile,
  }))
}
