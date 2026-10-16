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

/**
 * The model list of one engine as the picker shows it: a short list plus
 * a search over the whole catalog, with a per-engine "show all" preference.
 *
 * Featured/expand: when the engine has a featured set, show only those by
 * default. Engines with no featured marking (opencode, whose catalog is the
 * whole provider surface) show the first few instead. Both include the CURRENT
 * model first, so the selected row is never hidden by the short list. `expanded`
 * is the deliberate "show everything" opt-in, remembered per engine; the list
 * stays a fixed-height scroller even then, so the menu cannot grow unbounded.
 *
 * A non-empty search is a strict filter over the whole catalog and gets its own
 * transient reveal flag: "Show N more" while searching must not flip the
 * persisted per-engine expand pref, or clearing the search afterwards would dump
 * the full catalog instead of restoring the short list. Featured sets are NOT
 * capped by MAX_VISIBLE_MODELS, only the no-featured "first few" is.
 */
export function useModelList(registry: EnginesResponse, engine: string, modelId: string): ModelList {
  const [expandedByEngine, setExpandedByEngine] = useState<Record<string, boolean>>(() => loadExpandedByEngine())
  // Free-text filter over the engine's whole catalog (not just the collapsed set).
  const [query, setQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)

  const models = registry.engines[engine]?.models ?? []
  const trimmedQuery = query.trim()
  const matchingModels = trimmedQuery.length > 0 ? models.filter((m) => modelMatchesQuery(m, trimmedQuery)) : null
  const hasFeatured = models.some((m) => m.featured)
  const collapsedModels = hasFeatured
    ? models.filter((m) => m.featured || m.id === modelId)
    : [
        ...models.filter((m) => m.id === modelId),
        ...models.filter((m) => m.id !== modelId).slice(0, MAX_VISIBLE_MODELS - 1),
      ]
  const expanded = expandedByEngine[engine] ?? false
  const baseFull = matchingModels ?? models
  // While searching, the collapsed form is just the first few matches; otherwise
  // it is `collapsedModels`, which already carries current-first and the
  // featured/no-featured split.
  const baseCollapsed = matchingModels ? matchingModels.slice(0, MAX_VISIBLE_MODELS) : collapsedModels
  const revealAll = matchingModels ? searchExpanded : expanded
  const visibleModels = revealAll ? baseFull : baseCollapsed
  const hiddenCount = revealAll ? 0 : Math.max(0, baseFull.length - baseCollapsed.length)
  const showExpandToggle = hiddenCount > 0 || (revealAll && baseFull.length > baseCollapsed.length)
  const expandLabel = revealAll ? 'Show fewer' : matchingModels ? `Show ${hiddenCount} more` : `More models (${hiddenCount})`

  const toggleExpanded = () => {
    // While searching, reveal without touching the persisted pref (see above).
    if (matchingModels) {
      setSearchExpanded((v) => !v)
      return
    }
    const next = !expanded
    setEngineExpanded(engine, next)
    setExpandedByEngine((prev) => ({ ...prev, [engine]: next }))
  }

  return {
    models,
    query,
    setQuery: (next) => { setQuery(next); setSearchExpanded(false) },
    clearSearch: () => { setQuery(''); setSearchExpanded(false) },
    trimmedQuery,
    visibleModels,
    showExpandToggle,
    expandLabel,
    toggleExpanded,
  }
}
