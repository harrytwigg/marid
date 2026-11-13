import { useState } from 'react'
import type { EngineRegistryEntry, EnginesResponse, ModelInfo } from '@/lib/api'
import { accountListLabel, modelsOfAccount, shownAccountName, type OpencodeAccountChoice } from './opencode-accounts'

/** The accounts the picker lists: none unless opencode is an engine it offers. */
function declaredRows(engines: EngineRegistryEntry[], accounts: OpencodeAccountChoice[] | undefined): OpencodeAccountChoice[] {
  return engines.some((e) => e.name === 'opencode') ? accounts ?? [] : []
}

/**
 * How the picker presents opencode when accounts are declared: which account's models it shows, the
 * rows the engine panel adds, and the model-list narrowing. With none declared (or no installed
 * opencode) every field is inert and the picker is exactly as it was.
 */
export function useOpencodeScope(opts: { registry: EnginesResponse; engines: EngineRegistryEntry[]; engine: string; modelId: string; accounts: OpencodeAccountChoice[] | undefined }) {
  const { registry, engines, engine, modelId, accounts } = opts
  // The account just browsed to, for the model it was browsed from: once the model moves on, the model's own account shows again.
  const [browsed, setBrowsed] = useState<{ forModel: string; account: string | undefined } | null>(null)
  const rows = declaredRows(engines, accounts)
  const models: ModelInfo[] = registry.engines.opencode?.models ?? []
  const hasOther = rows.length > 0 && modelsOfAccount(models, rows, undefined).length > 0
  const shown = shownAccountName({ models, accounts: rows, modelId, browsed })
  const scoped = engine === 'opencode' && rows.length > 0
  return {
    rows,
    hasOther,
    shown,
    /** Rows the engine panel would list for opencode: more than one makes "Switch engine" worth offering on its own. */
    rowCount: rows.length + (hasOther ? 1 : 0),
    /** Narrows the model list to the shown account; absent when the list is the engine's whole catalogue. */
    filter: scoped ? (all: ModelInfo[]) => modelsOfAccount(all, rows, shown) : undefined,
    listLabel: scoped ? accountListLabel(rows, shown) : undefined,
    browse: (account: string | undefined) => setBrowsed({ forModel: modelId, account }),
  }
}
