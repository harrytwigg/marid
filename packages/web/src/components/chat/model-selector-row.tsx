import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useEffect } from 'react'
import type { EnginesResponse } from '@/lib/api'
import { useModelRegistry, engineList, effortLevelsFor, findModel, defaultEffort, clampEffort, contextWindowFor } from '@/hooks/use-model-registry'
import { fmtK, formatContextUsage, type ContextUsage } from '@/lib/context-usage'
import { ModelPicker } from './model-picker'
import { useFallbackChains } from '@/hooks/use-fallback-chains'
import { engineDisplayName } from '@/lib/engine-names'

export interface SelectorValue {
  engine?: string
  model?: string
  effortLevel?: string
  /** Declared Claude account a new chat starts on; beside the bare engine, never inside it. */
  profile?: string
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
  /** Offer the declared Claude accounts as primary profiles (new-chat path only). */
  allowProfiles?: boolean
  /** The chosen employee runs on a remote host, where the gateway refuses a profile: hide the rows. */
  employeeRemote?: boolean
  /** An existing session's chosen profile name, shown in the label read-only. */
  sessionProfileName?: string | null
}

const effortLabelOf = (lvl: string) => lvl.charAt(0).toUpperCase() + lvl.slice(1)

/**
 * The engine to display. Keep the chosen/default one, unless it's an uninstalled engine on a NEW
 * chat — then fall back to the first installed one. Existing chats stay pinned to their
 * (possibly hidden) engine. A NEW chat whose selection resolved to a different (installed) engine
 * because the chosen one is unavailable syncs that back, so the created session is valid.
 */
function useResolvedEngine(registry: EnginesResponse | undefined, mode: 'new' | 'existing', value: SelectorValue, onChange: (next: SelectorValue) => void): string {
  const engines = engineList(registry)
  const preferred = value.engine ?? registry?.default
  const engine =
    mode === 'new' && engines.length > 0 && !engines.some((e) => e.name === preferred)
      ? engines[0].name
      : (preferred ?? '')

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
      ...(engine === 'claude' && value.profile ? { profile: value.profile } : {}),
    })
  }, [registry, mode, engine, value.engine])
  return engine
}

/** The model the selector shows: the chosen one, else the engine's current/default. */
function shownModelId(registry: EnginesResponse, engine: string, value: SelectorValue): string {
  return value.model ?? findModel(registry, engine, value.model)?.id ?? registry.engines[engine]?.defaultModel ?? ''
}

/** What the selector shows for the current value: the model, its effort levels and its label. */
function describeSelection(registry: EnginesResponse, engine: string, value: SelectorValue) {
  const modelId = shownModelId(registry, engine, value)
  const efforts = effortLevelsFor(registry, engine, modelId)
  const label = registry.engines[engine]?.models.find((m) => m.id === modelId)?.label
  // Only a chosen level is a real selection. With none set the engine sends
  // nothing and runs its own default, so the chip says "Default" instead of
  // naming a tier (medium) the engine will not run.
  const effort = value.effortLevel
  const effortLabel = effort ? effortLabelOf(effort) : efforts.length > 0 ? 'Default' : undefined
  return { modelId, efforts, effort, effortLabel, modelLabel: label ?? modelId ?? 'Model' }
}

/** The chip: `✦ Model · Effort ▾`. */
function SelectorTrigger({ modelLabel, effortLabel, disabled }: { modelLabel: string; effortLabel: string | undefined; disabled?: boolean }) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Model and effort: ${modelLabel}${effortLabel ? ` · ${effortLabel}` : ''}`}
        className="group inline-flex min-h-[40px] md:min-h-0 min-w-0 max-w-full items-center gap-1.5 rounded-lg border-none bg-transparent px-1.5 py-1 text-[length:var(--text-footnote)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:opacity-60 cursor-pointer"
      >
        <span aria-hidden className="shrink-0 text-[var(--accent)] text-[11px] leading-none">✦</span>
        <span className="truncate font-[var(--weight-semibold)] tracking-[-0.2px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">{modelLabel}</span>
        {effortLabel && (
          // First thing to drop on a narrow composer — measured against the composer container, so a narrow PANE drops it too, not just a narrow viewport.
          <span className="shrink-0 text-[var(--text-tertiary)] @max-[340px]/composer:hidden">· {effortLabel}</span>
        )}
        <span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]">▾</span>
      </button>
    </DropdownMenuTrigger>
  )
}

/** Effort — pill row; hidden when the model has no effort levels. */
function EffortRow({ efforts, effort, onPick }: { efforts: string[]; effort: string | undefined; onPick: (level: string) => void }) {
  if (efforts.length === 0) return null
  return (
    <>
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      <DropdownMenuLabel className="pt-0.5 pb-1 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        Effort
      </DropdownMenuLabel>
      <DropdownMenuLabel
        data-testid="effort-levels"
        className={`flex gap-1 px-1 pt-0 pb-1 font-normal ${efforts.length > 4 ? 'overflow-x-auto [-webkit-overflow-scrolling:touch]' : ''}`}
      >
        {efforts.map((lvl) => {
          const on = lvl === effort
          return (
            <button
              key={lvl}
              type="button"
              onClick={() => onPick(lvl)}
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
      </DropdownMenuLabel>
    </>
  )
}

/** Context usage — how full the window is on the most recent turn. Fresh chat (no tokens yet) shows just the window size, no bar. */
function ContextFooter({ usage }: { usage: ContextUsage | null }) {
  if (!usage) return null
  return (
    <>
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      <DropdownMenuLabel className="pt-0.5 pb-1.5 font-normal">
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
      </DropdownMenuLabel>
    </>
  )
}

/** The notes under the effort row of a persisted chat: a rejected update, or "applies to your next message". */
function SelectorNotes({ mode, errorNote, pendingNote }: Pick<ModelSelectorRowProps, 'mode' | 'errorNote' | 'pendingNote'>) {
  if (mode !== 'existing') return null
  if (errorNote) return <DropdownMenuLabel className="pt-0 pb-1 text-[length:var(--text-caption2)] font-normal text-[var(--system-red)]">{errorNote}</DropdownMenuLabel>
  if (!pendingNote) return null
  return <DropdownMenuLabel className="pt-0 pb-1 text-[length:var(--text-caption2)] font-normal italic text-[var(--text-quaternary)]">Applies to your next message</DropdownMenuLabel>
}

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
/** Declared Claude accounts offered on a new chat; a remembered profile that is no
 *  longer declared (or whose employee went remote) is dropped, not sent on. */
function usePrimaryProfiles(enabled: boolean, employeeRemote: boolean | undefined, value: SelectorValue, onChange: (next: SelectorValue) => void): string[] {
  const { data: chains } = useFallbackChains(undefined, enabled)
  const profiles = employeeRemote ? [] : (chains?.profiles.map((p) => p.name) ?? [])
  const stale = enabled && chains !== undefined && Boolean(value.profile) && !profiles.includes(value.profile as string)
  useEffect(() => {
    if (stale) onChange({ ...value, profile: undefined })
  }, [stale, value, onChange])
  return profiles
}

/** Keep the chosen profile when a pick stays on claude; drop it when it leaves. */
function withProfile(next: SelectorValue, profile?: string): SelectorValue {
  return next.engine === 'claude' && profile ? { ...next, profile } : next
}

/** The selection for picking a primary profile: claude and its model, with the profile beside it. */
function profileSelection(registry: EnginesResponse, engine: string, modelId: string, value: SelectorValue, profile: string | undefined): SelectorValue {
  if (engine === 'claude') return { engine, model: modelId, effortLevel: value.effortLevel, ...(profile ? { profile } : {}) }
  const ne = registry.engines.claude
  const nextModel = ne?.defaultModel ?? ne?.models[0]?.id
  return { engine: 'claude', model: nextModel, effortLevel: defaultEffort(effortLevelsFor(registry, 'claude', nextModel)), ...(profile ? { profile } : {}) }
}

export function ModelSelectorRow({ mode, value, onChange, pendingNote, errorNote, disabled, contextTokens, allowProfiles, employeeRemote, sessionProfileName }: ModelSelectorRowProps) {
  const { data: registry, isLoading } = useModelRegistry()
  const engine = useResolvedEngine(registry, mode, value, onChange)
  const profilesEnabled = Boolean(allowProfiles && mode === 'new')
  const profiles = usePrimaryProfiles(profilesEnabled, employeeRemote, value, onChange)
  if (isLoading || !registry) return null

  const { modelId, efforts, effort, effortLabel, modelLabel } = describeSelection(registry, engine, value)
  const pickEngine = (next: string) => {
    const ne = registry.engines[next]
    const nextModel = ne?.defaultModel ?? ne?.models[0]?.id
    onChange(withProfile({ engine: next, model: nextModel, effortLevel: defaultEffort(effortLevelsFor(registry, next, nextModel)) }, value.profile))
  }
  const pickProfile = (profile: string | undefined) => onChange(profileSelection(registry, engine, modelId, value, profile))
  const pickModel = (next: string) => onChange(withProfile({ engine, model: next, effortLevel: clampEffort(effortLevelsFor(registry, engine, next), value.effortLevel) }, value.profile))

  const profileName = mode === 'new' ? value.profile : (sessionProfileName ?? undefined)
  const shownModelLabel = profileName ? `${engineDisplayName(engine)} · ${profileName} · ${modelLabel}` : modelLabel

  return (
    <DropdownMenu>
      <SelectorTrigger modelLabel={shownModelLabel} effortLabel={effortLabel} disabled={disabled} />
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] p-1.5"
      >
        <ModelPicker registry={registry} engine={engine} modelId={modelId} onPickEngine={pickEngine} onPickModel={pickModel} profiles={profilesEnabled ? profiles : undefined} profile={value.profile} onPickProfile={profilesEnabled ? pickProfile : undefined}>
          <EffortRow efforts={efforts} effort={effort} onPick={(level) => onChange(withProfile({ engine, model: modelId, effortLevel: level }, value.profile))} />
          <SelectorNotes mode={mode} errorNote={errorNote} pendingNote={pendingNote} />
          <ContextFooter usage={formatContextUsage(contextTokens, contextWindowFor(registry, engine, modelId))} />
        </ModelPicker>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
