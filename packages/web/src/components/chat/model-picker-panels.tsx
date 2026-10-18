import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { CheckIcon, ChevronLeftIcon } from 'lucide-react'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { providerOf, providerLabel } from '@/hooks/use-model-registry'
import type { EngineRegistryEntry, ModelInfo } from '@/lib/api'
import { engineDisplayName } from '@/lib/engine-names'
import type { ModelList } from './use-model-list'

/** Live `prefers-reduced-motion` flag; transitions collapse to instant when true. */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    setReduce(mq.matches)
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/**
 * One panel of the picker surface. Mounts with a crisp directional fade+slide
 * (incoming from the right when going forward, from the left when going back);
 * `prefers-reduced-motion` swaps instantly. Keyed by the active panel in the
 * parent, so each panel change replays the entrance.
 */
export function SlidePanel({ dir, reduceMotion, children }: { dir: 1 | -1; reduceMotion: boolean; children: ReactNode }) {
  const [entered, setEntered] = useState(reduceMotion)
  useEffect(() => {
    if (reduceMotion) {
      setEntered(true)
      return
    }
    const r = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(r)
  }, [reduceMotion])
  return (
    <div
      style={{
        opacity: entered ? 1 : 0,
        transform: entered ? 'translateX(0)' : `translateX(${dir * 10}px)`,
        transition: reduceMotion ? 'none' : 'opacity 180ms var(--ease-smooth), transform 200ms var(--ease-snappy)',
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  )
}

const SECTION_LABEL = 'px-2 pt-0.5 pb-1 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]'

/** The panel's "Back" row. */
export function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <DropdownMenuItem
      onSelect={(e) => { e.preventDefault(); onBack() }}
      className="gap-1 rounded-[9px] py-1.5 pl-1.5 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
    >
      <ChevronLeftIcon className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
      <span className="flex-1">Back</span>
    </DropdownMenuItem>
  )
}

/** The search field. Radix reads printable keys as menu typeahead and ignores arrows from a nested
 *  input, so printable keys stay in the field, Escape and Tab pass through, and ArrowDown/Up hand focus
 *  to the first/last result (`listRef`), or the field is a keyboard dead end. */
function ModelSearchBox({ list, listRef }: { list: ModelList; listRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="px-1 pb-1">
      <input
        type="search"
        value={list.query}
        onChange={(e) => list.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            e.stopPropagation()
            const items = listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
            if (items && items.length) {
              items[e.key === 'ArrowDown' ? 0 : items.length - 1].focus()
            }
            return
          }
          if (e.key === 'Escape' || e.key === 'Tab') return
          e.stopPropagation()
        }}
        placeholder="Search models…"
        aria-label="Search models"
        className="w-full rounded-[8px] bg-[var(--fill-tertiary)] px-2 py-1.5 text-[length:var(--text-footnote)] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] outline-none focus:bg-[var(--fill-secondary)]"
      />
    </div>
  )
}

/** One model row: label, provider badge, accent check on the selected. */
function ModelRow({ model, selected, keepOpenOnPick }: { model: ModelInfo; selected: boolean; keepOpenOnPick?: boolean }) {
  const provider = providerOf(model.id)
  return (
    <DropdownMenuRadioItem
      value={model.id}
      onSelect={keepOpenOnPick ? (e) => e.preventDefault() : undefined}
      className="justify-between gap-2 rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[state=checked]:font-[var(--weight-semibold)] data-[state=checked]:text-[var(--text-primary)] [&>span:first-child]:hidden"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{model.label}</span>
        {provider && (
          <span className="shrink-0 rounded-[5px] bg-[var(--fill-tertiary)] px-1 py-px text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
            {providerLabel(provider)}
          </span>
        )}
      </span>
      {selected && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
    </DropdownMenuRadioItem>
  )
}

/** The results: a fixed-height scroller, so even the expanded opencode catalog stays inside the composer. */
function ModelRows({ list, modelId, onPickModel, keepOpenOnPick, listRef }: {
  list: ModelList
  modelId: string
  onPickModel: (model: string) => void
  keepOpenOnPick?: boolean
  listRef: RefObject<HTMLDivElement | null>
}) {
  if (list.visibleModels.length === 0) {
    return (
      <div className="px-2 py-1.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        No models match “{list.trimmedQuery}”.
      </div>
    )
  }
  return (
    <div ref={listRef} className="max-h-[min(50vh,270px)] overflow-y-auto">
      <DropdownMenuRadioGroup value={modelId} onValueChange={onPickModel}>
        {list.visibleModels.map((m) => (
          <ModelRow key={m.id} model={m} selected={m.id === modelId} keepOpenOnPick={keepOpenOnPick} />
        ))}
      </DropdownMenuRadioGroup>
    </div>
  )
}

/** The model search and short radio list of one engine, under an engine header. */
export function ModelListPanel({ engine, modelId, list, onPickModel, keepOpenOnPick }: {
  engine: string
  modelId: string
  list: ModelList
  onPickModel: (model: string) => void
  /** A model pick leaves the menu open (the parent closes it when the pick has been taken). */
  keepOpenOnPick?: boolean
}) {
  // The results scroller, so the search field can hand focus to it.
  const listRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div className="px-2 pt-1 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        Engine · {engineDisplayName(engine)}
      </div>
      {list.models.length === 0 ? (
        <div className="px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">
          No models discovered yet.
        </div>
      ) : (
        <>
          <ModelSearchBox list={list} listRef={listRef} />
          <ModelRows list={list} modelId={modelId} onPickModel={onPickModel} keepOpenOnPick={keepOpenOnPick} listRef={listRef} />
          {list.showExpandToggle && (
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); list.toggleExpanded() }}
              className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
            >
              {list.expandLabel}
            </DropdownMenuItem>
          )}
        </>
      )}
    </>
  )
}

/** The engine list: pick one to browse its models. */
export function EnginePanel({ engines, engine, onBack, onChoose, onRefresh }: {
  engines: EngineRegistryEntry[]
  engine: string
  onBack: () => void
  onChoose: (engine: string) => void
  onRefresh: () => void
}) {
  return (
    <>
      <BackRow onBack={onBack} />
      <div className={SECTION_LABEL}>Switch engine</div>
      {engines.map((e) => {
        const on = e.name === engine
        return (
          <DropdownMenuItem
            key={e.name}
            onSelect={(ev) => { ev.preventDefault(); onChoose(e.name) }}
            aria-checked={on}
            className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
          >
            <span className={on ? 'font-[var(--weight-semibold)] text-[var(--text-primary)]' : undefined}>
              {engineDisplayName(e.name)}
            </span>
            {on && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
          </DropdownMenuItem>
        )
      })}
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      <DropdownMenuItem
        onSelect={(e) => { e.preventDefault(); onRefresh() }}
        className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
      >
        ↻ Refresh models
      </DropdownMenuItem>
    </>
  )
}
