import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRightIcon } from '@/components/ui/icon'
import { useQueryClient } from '@tanstack/react-query'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { api, type EnginesResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { engineList } from '@/hooks/use-model-registry'
import { useModelList } from './use-model-list'
import { BackRow, EnginePanel, ModelListPanel, SlidePanel, usePrefersReducedMotion } from './model-picker-panels'

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

/** The picker's navigation between its panels, with the focus-parking and height animation the single surface needs. */
function usePickerNav() {
  // Which panel is showing inside the one surface ('main' = models, 'engine' = engine list).
  // `dir` drives the slide direction (forward / back).
  const [panel, setPanel] = useState<'main' | 'engine'>('main')
  const [dir, setDir] = useState<1 | -1>(1)
  // Focus-parking target: a tabindex=-1 wrapper INSIDE the menu layer. Parking
  // focus here before a panel swap keeps focus within the layer so Radix's
  // focus-outside dismissal never fires when the active item unmounts.
  const panelWrapRef = useRef<HTMLDivElement>(null)
  // Animated height of the surface as panels of different sizes swap in.
  const [surfaceH, setSurfaceH] = useState<number>()
  // Skip the focus-confirm on mount (Radix focuses the content itself).
  const firstPanel = useRef(true)

  // Track the surface height across panel swaps / content changes so the height
  // animates instead of snapping. ResizeObserver covers panel swaps AND any
  // model/effort/context content changes within a panel.
  useLayoutEffect(() => {
    const el = panelWrapRef.current
    if (!el) return
    setSurfaceH(el.offsetHeight)
    const ro = new ResizeObserver(() => setSurfaceH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // After a panel change (not the initial mount), re-park focus inside the layer
  // so keyboard users can arrow into the new panel and Esc still closes.
  useLayoutEffect(() => {
    if (firstPanel.current) {
      firstPanel.current = false
      return
    }
    panelWrapRef.current?.focus()
  }, [panel])

  // Park focus inside the layer, then move to the requested panel. Parking is
  // synchronous so the unmounting active item never drops focus to <body>.
  const goToPanel = (next: 'main' | 'engine') => {
    setDir(next === 'engine' ? 1 : -1)
    panelWrapRef.current?.focus()
    setPanel(next)
  }
  return { panel, dir, panelWrapRef, surfaceH, goToPanel }
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
  const reduceMotion = usePrefersReducedMotion()
  const list = useModelList(registry, engine, modelId)
  const nav = usePickerNav()
  const refreshModels = useRefreshModels()
  const engines = engineList(registry).filter((e) => !isEngineAllowed || isEngineAllowed(e.name))

  // Choose an engine from the engine panel, then auto-return to the model panel
  // (now reflecting that engine's models). Re-picking the current engine is a
  // no-op selection: just slide back.
  const chooseEngine = (next: string) => {
    // The old engine's filter means nothing for the new one — drop it, or the
    // new engine's models render as an empty "no match" list.
    list.clearSearch()
    if (next !== engine) onPickEngine(next)
    nav.goToPanel('main')
  }

  return (
    // Single surface; height animates as the two panels swap in place.
    <div
      style={{
        height: nav.surfaceH != null ? `${nav.surfaceH}px` : undefined,
        overflow: 'hidden',
        transition: reduceMotion ? 'none' : 'height 200ms var(--ease-smooth)',
      }}
    >
      <div ref={nav.panelWrapRef} tabIndex={-1} className="outline-none">
        <SlidePanel key={nav.panel} dir={nav.dir} reduceMotion={reduceMotion}>
          {nav.panel === 'main' ? (
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
          )}
        </SlidePanel>
      </div>
    </div>
  )
}
