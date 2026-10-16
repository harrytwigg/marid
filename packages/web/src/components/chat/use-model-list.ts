import { useState } from 'react'
import type { EnginesResponse, ModelInfo } from '@/lib/api'
import { modelMatchesQuery } from '@/hooks/use-model-registry'
import { loadExpandedByEngine, setEngineExpanded } from '@/lib/model-picker-prefs'

/** Rows the model list shows before the operator asks for more. opencode's
 *  catalog can be hundreds of models, so the picker is a short list plus a
 *  search box, never the whole registry in one scroll of the composer. */
export const MAX_VISIBLE_MODELS = 5

export interface ModelList {
  models: ModelInfo[]
  query: string
  setQuery: (next: string) => void
  /** A search is a one-look action: forget the filter and its reveal. */
  clearSearch: () => void
  trimmedQuery: string
  visibleModels: ModelInfo[]
  showExpandToggle: boolean
  expandLabel: string
  toggleExpanded: () => void
}

/** The short form of a catalog: the featured set when the engine marks one, else the first few. Both keep the CURRENT model. */
function collapsedModels(models: ModelInfo[], modelId: string): ModelInfo[] {
  if (models.some((m) => m.featured)) return models.filter((m) => m.featured || m.id === modelId)
  return [
    ...models.filter((m) => m.id === modelId),
    ...models.filter((m) => m.id !== modelId).slice(0, MAX_VISIBLE_MODELS - 1),
  ]
}

/**
 * What the picker shows of one engine's catalog. A non-empty search is a strict
 * filter over the whole catalog (collapsed to its first few matches until revealed);
 * otherwise the short form shows until the per-engine "show all" opt-in. Featured sets
 * are NOT capped by MAX_VISIBLE_MODELS: only the no-featured "first few" is.
 */
function listWindow(models: ModelInfo[], modelId: string, trimmedQuery: string, revealAll: boolean) {
  const matching = trimmedQuery ? models.filter((m) => modelMatchesQuery(m, trimmedQuery)) : null
  const full = matching ?? models
  const collapsed = matching ? matching.slice(0, MAX_VISIBLE_MODELS) : collapsedModels(models, modelId)
  const hiddenCount = revealAll ? 0 : Math.max(0, full.length - collapsed.length)
  return {
    visibleModels: revealAll ? full : collapsed,
    showExpandToggle: hiddenCount > 0 || (revealAll && full.length > collapsed.length),
    expandLabel: revealAll ? 'Show fewer' : matching ? `Show ${hiddenCount} more` : `More models (${hiddenCount})`,
  }
}

/**
 * The model list of one engine as the picker shows it: a short list plus a search over
 * the whole catalog, with a per-engine "show all" preference. The list stays a
 * fixed-height scroller even expanded, so the menu cannot grow unbounded.
 *
 * Searching gets its own transient reveal flag: "Show N more" while searching must not
 * flip the persisted per-engine expand pref, or clearing the search afterwards would
 * dump the full catalog instead of restoring the short list.
 */
export function useModelList(registry: EnginesResponse, engine: string, modelId: string): ModelList {
  const [expandedByEngine, setExpandedByEngine] = useState<Record<string, boolean>>(() => loadExpandedByEngine())
  const [query, setQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)

  const models = registry.engines[engine]?.models ?? []
  const trimmedQuery = query.trim()
  const searching = trimmedQuery.length > 0
  const expanded = expandedByEngine[engine] ?? false
  const window = listWindow(models, modelId, trimmedQuery, searching ? searchExpanded : expanded)

  const toggleExpanded = () => {
    if (searching) return setSearchExpanded((v) => !v)
    setEngineExpanded(engine, !expanded)
    setExpandedByEngine((prev) => ({ ...prev, [engine]: !expanded }))
  }

  return {
    models,
    query,
    setQuery: (next) => { setQuery(next); setSearchExpanded(false) },
    clearSearch: () => { setQuery(''); setSearchExpanded(false) },
    trimmedQuery,
    toggleExpanded,
    ...window,
  }
}
