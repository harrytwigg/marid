import { useState } from 'react'
import { useModelRegistry } from '@/hooks/use-model-registry'
import { ModelPicker } from './model-picker'
import type { FallbackTargetChoice, SessionFallbackView } from './fallback-mode-model'

/**
 * The fallback chip's model picker: the new-chat selector's own `ModelPicker`, used pick-only.
 * Browsing an engine changes nothing; a model row is the choice. Only the engines the session
 * may use are offered (`view.allowedEngines`), and the session's own target is the one marked.
 */
export function FallbackTargetPicker({ view, onChoose, onBack }: {
  view: SessionFallbackView
  onChoose: (choice: FallbackTargetChoice) => void
  onBack: () => void
}) {
  const { data: registry } = useModelRegistry()
  const own = view.targetSource === 'session' ? view.target : null
  const allowed = view.allowedEngines
  const isEngineAllowed = (name: string) => !allowed || allowed.includes(name)
  const [browsing, setBrowsing] = useState<string | undefined>(own?.engine)
  if (!registry) return <div className="px-2 py-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Loading models…</div>

  const installed = Object.values(registry.engines).filter((e) => e.available && isEngineAllowed(e.name))
  if (installed.length === 0) {
    return <div className="px-2 py-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">No engine is available as a fallback for this session.</div>
  }
  // The engine being browsed: the one just picked, else the session's own target, else the first allowed.
  const engine = installed.some((e) => e.name === browsing) ? browsing! : installed[0].name

  return (
    <ModelPicker
      registry={registry}
      engine={engine}
      modelId={own?.engine === engine ? own.model ?? '' : ''}
      onPickEngine={setBrowsing}
      onPickModel={(model) => onChoose({ engine, model })}
      isEngineAllowed={isEngineAllowed}
      keepOpenOnPick
      onBack={onBack}
    />
  )
}
