import { CheckIcon, ChevronLeftIcon } from "@/components/ui/icon"
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { providerOf, providerLabel } from '@/hooks/use-model-registry'
import type { EngineRegistryEntry, ModelInfo } from '@/lib/api'
import { engineDisplayName } from '@/lib/engine-names'
import type { ModelList } from './use-model-list'

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

/** The search field. The menu reads printable keys as typeahead, so they stay in the field (Escape and
 *  Tab pass through), and ArrowDown/Up hand focus to the first/last result, or the field is a keyboard
 *  dead end. It sits in a label, the one part of the menu's list that holds a field. */
function ModelSearchBox({ list }: { list: ModelList }) {
  return (
    <DropdownMenuLabel className="px-1 pb-1 pt-0 font-normal">
      <input
        type="search"
        value={list.query}
        onChange={(e) => list.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            e.stopPropagation()
            const items = e.currentTarget.closest('[role="menu"]')?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
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
    </DropdownMenuLabel>
  )
}

/** One model row: label, provider badge, accent check on the selected. */
function ModelRow({ model, selected, keepOpenOnPick }: { model: ModelInfo; selected: boolean; keepOpenOnPick?: boolean }) {
  const provider = providerOf(model.id)
  return (
    <DropdownMenuRadioItem
      value={model.id}
      onSelect={keepOpenOnPick ? (e) => e.preventDefault() : undefined}
      className="justify-between gap-2 rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[selected]:font-[var(--weight-semibold)] data-[selected]:text-[var(--text-primary)] [&>span:first-child]:hidden"
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

/** The results. A long (expanded) catalog scrolls with the rest of the menu, whose height is capped by its content. */
function ModelRows({ list, modelId, onPickModel, keepOpenOnPick }: {
  list: ModelList
  modelId: string
  onPickModel: (model: string) => void
  keepOpenOnPick?: boolean
}) {
  if (list.visibleModels.length === 0) {
    return (
      <DropdownMenuLabel className="py-1.5 text-[length:var(--text-caption1)] font-normal text-[var(--text-secondary)]">
        No models match “{list.trimmedQuery}”.
      </DropdownMenuLabel>
    )
  }
  return (
    <DropdownMenuRadioGroup value={modelId} onValueChange={onPickModel} aria-label="Models">
      {list.visibleModels.map((m) => (
        <ModelRow key={m.id} model={m} selected={m.id === modelId} keepOpenOnPick={keepOpenOnPick} />
      ))}
    </DropdownMenuRadioGroup>
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
  return (
    <>
      <DropdownMenuLabel className={`${SECTION_LABEL} pt-1 pb-1.5`}>
        Engine · {engineDisplayName(engine)}
      </DropdownMenuLabel>
      {list.models.length === 0 ? (
        <DropdownMenuLabel className="py-1.5 text-[length:var(--text-caption1)] font-normal leading-snug text-[var(--text-secondary)]">
          No models discovered yet.
        </DropdownMenuLabel>
      ) : (
        <>
          <ModelSearchBox list={list} />
          <ModelRows list={list} modelId={modelId} onPickModel={onPickModel} keepOpenOnPick={keepOpenOnPick} />
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

/** One engine row in the engine panel. */
function EngineRow({ label, on, onPick }: { label: string; on: boolean; onPick: () => void }) {
  return (
    <DropdownMenuItem
      onSelect={(ev) => { ev.preventDefault(); onPick() }}
      aria-checked={on}
      className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
    >
      <span className={on ? 'font-[var(--weight-semibold)] text-[var(--text-primary)]' : undefined}>
        {label}
      </span>
      {on && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
    </DropdownMenuItem>
  )
}

/** The engine list: pick one to browse its models. With declared Claude accounts, Claude is
 *  listed once per profile — the plain row is the employee's/gateway's own login. */
export function EnginePanel({ engines, engine, onBack, onChoose, onRefresh, profiles, profile, onChooseProfile }: {
  engines: EngineRegistryEntry[]
  engine: string
  onBack: () => void
  onChoose: (engine: string) => void
  onRefresh: () => void
  /** Declared Claude account names; empty/absent leaves the panel exactly as before. */
  profiles?: string[]
  profile?: string
  onChooseProfile?: (profile: string | undefined) => void
}) {
  return (
    <>
      <BackRow onBack={onBack} />
      <DropdownMenuLabel className={SECTION_LABEL}>Switch engine</DropdownMenuLabel>
      {engines.flatMap((e) => {
        if (e.name !== 'claude' || !profiles?.length || !onChooseProfile) {
          return [<EngineRow key={e.name} label={engineDisplayName(e.name)} on={e.name === engine} onPick={() => onChoose(e.name)} />]
        }
        return [
          <EngineRow
            key="claude"
            label={engineDisplayName('claude')}
            on={engine === 'claude' && !profile}
            onPick={() => onChooseProfile(undefined)}
          />,
          ...profiles.map((name) => (
            <EngineRow
              key={`claude:${name}`}
              label={`${engineDisplayName('claude')} · ${name}`}
              on={engine === 'claude' && profile === name}
              onPick={() => onChooseProfile(name)}
            />
          )),
        ]
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
