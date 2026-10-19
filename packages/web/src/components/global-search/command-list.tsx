import { Play, Plus, SquareArrowRight, UserRoundPlus, type IconComponent } from "@/components/ui/icon"
import type { Verb, VerbName } from "./verbs"

/* The verb list, in the pane the results usually sit in. It wears the result
 * row's shape on purpose: ↑↓ and ⏎ mean what they meant a keystroke ago. */

const GROUP_HEAD = "px-[10px] pt-3 pb-[5px] text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]"
const ROW = "flex min-h-[42px] cursor-default items-center gap-[11px] rounded-[var(--radius-md)] px-[10px] py-2"

const VERB_ICON: Record<VerbName, IconComponent> = {
  assign: UserRoundPlus,
  move: SquareArrowRight,
  run: Play,
  new: Plus,
}

export interface CommandListProps {
  verbs: readonly Verb[]
  selectedIndex: number
  onSelect: (index: number) => void
  onPick: (verb: Verb) => void
}

export function CommandList({ verbs, selectedIndex, onSelect, onPick }: CommandListProps) {
  if (verbs.length === 0) {
    return (
      <p className="px-[10px] pt-4 text-[13.5px] text-[var(--text-tertiary)]" data-testid="command-list-empty">
        No command by that name
      </p>
    )
  }
  return (
    <div role="listbox" aria-label="Commands" className="flex flex-col">
      <div className={GROUP_HEAD} role="presentation">Commands</div>
      {verbs.map((verb, index) => {
        const Icon = VERB_ICON[verb.name]
        const selected = index === selectedIndex
        return (
          <div
            key={verb.name}
            role="option"
            aria-selected={selected}
            data-testid={`command-row-${verb.name}`}
            onPointerMove={() => onSelect(index)}
            onClick={() => onPick(verb)}
            className={`${ROW} ${selected ? "bg-[var(--accent-fill)]" : ""}`}
          >
            <span className={`grid size-6 flex-none place-items-center rounded-[7px] ${selected ? "bg-[var(--accent)] text-[var(--accent-contrast)]" : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)]"}`}>
              <Icon size={13} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] tracking-[-0.005em] text-[var(--text-primary)]">{verb.name}</span>
              <span className="mt-0.5 block truncate text-[12px] text-[var(--text-tertiary)]">{verb.description}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
