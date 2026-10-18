import { useState, type ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { api, type EnginesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { engineList } from '@/hooks/use-model-registry'
import { useModelList } from './use-model-list'
import { BackRow, EnginePanel, ModelListPanel } from './model-picker-panels'

export interface ModelPickerProps {
  registry: EnginesResponse
  /** The engine whose models are listed. Controlled: the parent decides what an engine pick means. */
  engine: string
  /** The selected model, or '' for none. */
  modelId: string
  onPickEngine: (engine: string) => void
  onPickModel: (model: string) => void
  /** Offer only some installed engines (a session's fallback may not use every one). */
  isEngineAllowed?: (engine: string) => boolean
  /** A model pick leaves the menu open, for a parent that closes it once the pick has been accepted. */
  keepOpenOnPick?: boolean
  /** Adds a Back row to the model panel, for a picker opened from another menu panel. */
  onBack?: () => void
  /** Rows the parent adds below the model list (effort, context), above the engine switch. */
  children?: ReactNode
}

/** Which panel is showing inside the one surface: 'main' (models) or 'engine' (the engine list). Switching swaps the
 *  items in place; React Aria moves focus to the list when the item that had it is gone. */
function usePickerNav() {
  const [panel, setPanel] = useState<'main' | 'engine'>('main')
  return { panel, goToPanel: setPanel }
}

/** Re-discover dynamic (pi) models without a restart, then update the cache. */
function useRefreshModels(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void api.refreshEngines()
      .then((fresh) => queryClient.setQueryData(queryKeys.engines.all, fresh))
      .catch(() => queryClient.invalidateQueries({ queryKey: queryKeys.engines.all }))
  }
}

/** The model panel's footer: the engine switch, or a refresh when there is no other engine to switch to. */
function EngineSwitchRow({ canSwitch, onSwitch, onRefresh }: { canSwitch: boolean; onSwitch: () => void; onRefresh: () => void }) {
  return (
    <>
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      {canSwitch ? (
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); onSwitch() }}
          className="rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
        >
          <span className="flex-1">Switch engine…</span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-[var(--text-quaternary)]" />
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); onRefresh() }}
          className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
        >
          ↻ Refresh models
        </DropdownMenuItem>
      )}
    </>
  )
}

/**
 * The engine and model picker as one surface inside a dropdown menu: a model
 * panel (engine header, search, short list) and an engine panel the "Switch
 * engine" row slides to. The new-chat selector and the fallback chip both
 * render it, so they search and list models the same way. It owns navigation and
 * search; what a pick means (apply at once, or just browse) is the parent's.
 */
export function ModelPicker({ registry, engine, modelId, onPickEngine, onPickModel, isEngineAllowed, keepOpenOnPick, onBack, children }: ModelPickerProps) {
  const list = useModelList(registry, engine, modelId)
  const nav = usePickerNav()
  const refreshModels = useRefreshModels()
  const engines = engineList(registry).filter((e) => !isEngineAllowed || isEngineAllowed(e.name))

  // Choose an engine from the engine panel, then auto-return to the model panel
  // (now reflecting that engine's models). Re-picking the current engine is a
  // no-op selection: just go back.
  const chooseEngine = (next: string) => {
    // The old engine's filter means nothing for the new one — drop it, or the
    // new engine's models render as an empty "no match" list.
    list.clearSearch()
    if (next !== engine) onPickEngine(next)
    nav.goToPanel('main')
  }

  return nav.panel === 'main' ? (
    <>
      {onBack && <BackRow onBack={onBack} />}
      <ModelListPanel engine={engine} modelId={modelId} list={list} onPickModel={onPickModel} keepOpenOnPick={keepOpenOnPick} />
      {children}
      <EngineSwitchRow
        canSwitch={engines.some((e) => e.name !== engine)}
        onSwitch={() => nav.goToPanel('engine')}
        onRefresh={refreshModels}
      />
    </>
  ) : (
    <EnginePanel engines={engines} engine={engine} onBack={() => nav.goToPanel('main')} onChoose={chooseEngine} onRefresh={refreshModels} />
  )
}
