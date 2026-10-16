import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useEffect } from 'react'
import { useModelRegistry, engineList, effortLevelsFor, findModel, defaultEffort, clampEffort, contextWindowFor } from '@/hooks/use-model-registry'
import { fmtK, formatContextUsage } from '@/lib/context-usage'
import { ModelPicker } from './model-picker'

export interface SelectorValue {
  engine?: string
  model?: string
  effortLevel?: string
}

interface ModelSelectorRowProps {
  /** 'new' = pre-create selection; 'existing' = persisted to the active chat. */
  mode: 'new' | 'existing'
  value: SelectorValue
  onChange: (next: SelectorValue) => void
  /** Shown in 'existing' mode to hint the change applies on the next message. */
  pendingNote?: boolean
  /** Shown in 'existing' mode when a model/effort update is rejected. */
  errorNote?: string
  disabled?: boolean
  /** Most recent turn's input-context token count (session.lastContextTokens),
   *  for the in-dropdown context meter. Omitted/0 → fresh chat (window-only). */
  contextTokens?: number | null
}

const effortLabelOf = (lvl: string) => lvl.charAt(0).toUpperCase() + lvl.slice(1)

/**
 * Engine / Model / Effort selector for the chat composer, rendered as a single
 * "chip" trigger (`✦ Opus 4.8 · High ▾`) that opens one consolidated dropdown:
 * engine header, model radio list, effort pill row, a context-usage footer, and
 * a "Switch engine" affordance. All options come from the live registry
 * (GET /api/engines); nothing is hardcoded.
 *  - Engine: editable in-place; existing chats persist the change for the next turn.
 *  - Model: editable always.
 *  - Effort: editable always; hidden entirely for models with no effort levels.
 * Cascading: changing engine resets model to that engine's default; changing model
 * clamps effort to a level valid for the new model.
 *
 * The model list, search and engine panel are the shared `ModelPicker`; this adds
 * the effort row, notes and context footer around it.
 */
export function ModelSelectorRow({ mode, value, onChange, pendingNote, errorNote, disabled, contextTokens }: ModelSelectorRowProps) {
  const { data: registry, isLoading } = useModelRegistry()

  // Resolve the engine to display. Keep the chosen/default one, unless it's an
  // uninstalled engine on a NEW chat — then fall back to the first installed one.
  // Existing chats stay pinned to their (possibly hidden) engine.
  const engines = engineList(registry)
  const preferred = value.engine ?? registry?.default
  const engine =
    mode === 'new' && engines.length > 0 && !engines.some((e) => e.name === preferred)
      ? engines[0].name
      : (preferred ?? '')

  // If a NEW chat's selection resolved to a different (installed) engine because
  // the chosen one is unavailable, sync that back so the created session is valid.
  useEffect(() => {
    if (mode !== 'new' || !registry) return
    const pref = value.engine ?? registry.default
    if (engines.length === 0 || engines.some((e) => e.name === pref)) return
    const ne = registry.engines[engine]
    if (!ne) return
    onChange({
      engine,
      model: ne.defaultModel,
      effortLevel: defaultEffort(effortLevelsFor(registry, engine, ne.defaultModel)),
    })
  }, [registry, mode, engine, value.engine])

  if (isLoading || !registry) return null

  const entry = registry.engines[engine]
  const models = entry?.models ?? []
  const currentModel = findModel(registry, engine, value.model)
  const modelId = value.model ?? currentModel?.id ?? entry?.defaultModel ?? ''
  const efforts = effortLevelsFor(registry, engine, modelId)
  const effort = value.effortLevel ?? defaultEffort(efforts)

  const modelLabel = models.find((m) => m.id === modelId)?.label ?? modelId ?? 'Model'
  const usage = formatContextUsage(contextTokens, contextWindowFor(registry, engine, modelId))

  const pickEngine = (nextEngine: string) => {
    const ne = registry.engines[nextEngine]
    const nextModel = ne?.defaultModel ?? ne?.models[0]?.id
    onChange({
      engine: nextEngine,
      model: nextModel,
      effortLevel: defaultEffort(effortLevelsFor(registry, nextEngine, nextModel)),
    })
  }

  const pickModel = (nextModel: string) => {
    const nextEffort = clampEffort(effortLevelsFor(registry, engine, nextModel), value.effortLevel)
    onChange({ engine, model: nextModel, effortLevel: nextEffort })
  }

  const pickEffort = (nextEffort: string) => {
    onChange({ engine, model: modelId, effortLevel: nextEffort })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model and effort: ${modelLabel}${effort ? ` · ${effortLabelOf(effort)}` : ''}`}
          className="group inline-flex min-h-[40px] md:min-h-0 min-w-0 max-w-full items-center gap-1.5 rounded-lg border-none bg-transparent px-1.5 py-1 text-[length:var(--text-footnote)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:opacity-60 cursor-pointer"
        >
          <span aria-hidden className="shrink-0 text-[var(--accent)] text-[11px] leading-none">✦</span>
          <span className="truncate font-[var(--weight-semibold)] tracking-[-0.2px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">{modelLabel}</span>
          {effort && (
            // First thing to drop on a narrow composer — measured against the composer container, so a narrow PANE drops it too, not just a narrow viewport.
            <span className="shrink-0 text-[var(--text-tertiary)] @max-[340px]/composer:hidden">· {effortLabelOf(effort)}</span>
          )}
          <span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]">▾</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-lg)] border-0 bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]"
      >
        <ModelPicker registry={registry} engine={engine} modelId={modelId} onPickEngine={pickEngine} onPickModel={pickModel}>
          {/* Effort — pill row; hidden when the model has no effort levels. */}
          {efforts.length > 0 && (
            <>
              <DropdownMenuSeparator className="bg-[var(--separator)]" />
              <div className="px-2 pt-0.5 pb-1 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
                Effort
              </div>
              <div
                data-testid="effort-levels"
                className={`flex gap-1 px-1 pb-1 ${efforts.length > 4 ? 'overflow-x-auto [-webkit-overflow-scrolling:touch]' : ''}`}
              >
                {efforts.map((lvl) => {
                  const on = lvl === effort
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => pickEffort(lvl)}
                      aria-pressed={on}
                      className={`${efforts.length > 4 ? 'min-w-[56px] shrink-0 px-2' : 'flex-1'} rounded-[8px] py-1.5 text-center text-[length:var(--text-caption1)] capitalize transition-colors ${
                        on
                          ? 'bg-[var(--accent-fill)] font-[var(--weight-semibold)] text-[var(--accent)]'
                          : 'bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {lvl}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {mode === 'existing' && errorNote && (
            <div className="px-2 pb-1 text-[length:var(--text-caption2)] text-[var(--system-red)]">
              {errorNote}
            </div>
          )}
          {mode === 'existing' && !errorNote && pendingNote && (
            <div className="px-2 pb-1 text-[length:var(--text-caption2)] italic text-[var(--text-quaternary)]">
              Applies to your next message
            </div>
          )}

          {/* Context usage — how full the window is on the most recent turn.
              Fresh chat (no tokens yet) shows just the window size, no bar. */}
          {usage && (
            <>
              <DropdownMenuSeparator className="bg-[var(--separator)]" />
              <div className="px-2 pt-0.5 pb-1.5">
                <div className="flex items-center justify-between text-[length:var(--text-caption1)]">
                  <span className="text-[var(--text-tertiary)]">Context</span>
                  {usage.tokens > 0 ? (
                    <span
                      className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-secondary)]"
                      style={usage.color ? { color: usage.color } : undefined}
                      title={`${usage.tokens.toLocaleString()} / ${usage.window.toLocaleString()} tokens (${Math.round(usage.rawPct * 100)}%)`}
                    >
                      {usage.label}
                    </span>
                  ) : (
                    <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-quaternary)]">
                      {fmtK(usage.window)} window
                    </span>
                  )}
                </div>
                {usage.tokens > 0 && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(usage.pct * 100, 2)}%`, background: usage.color ?? 'var(--accent)' }}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </ModelPicker>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
