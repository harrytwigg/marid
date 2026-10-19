import { cn } from "@/lib/utils"
import type { BoardView, ColumnPosition } from "./phone-board"

/* The phone's Board | List switch. It is two native radio inputs in HeroUI's
 * tabs classes, not the React Aria tabs: a radio group already has the arrow
 * keys, and the board's chunk has no room for the tabs' runtime. The checked
 * tab is drawn from `:has(input:checked)` in heroui-glass.css. */

const VIEWS: readonly { id: BoardView; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
]

export function BoardViewSwitch({ value, onChange }: { value: BoardView; onChange: (view: BoardView) => void }) {
  return (
    <div className="tabs ml-auto" data-orientation="horizontal">
      <div className="tabs__list-container">
        <div role="radiogroup" aria-label="Board layout" className="tabs__list" data-orientation="horizontal" data-testid="board-view-switch">
          {VIEWS.map((view) => (
            <label
              key={view.id}
              className="tabs__tab h-10 min-w-16 cursor-pointer"
              data-selected={value === view.id}
              data-testid={`board-view-${view.id}`}
            >
              <input
                type="radio"
                name="board-view"
                value={view.id}
                checked={value === view.id}
                onChange={() => onChange(view.id)}
                className="sr-only"
              />
              {view.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Which column the strip is on: dots, and the count beside them. */
export function ColumnDots({ index, total }: ColumnPosition) {
  if (total < 2) return null
  return (
    <div role="img" aria-label={`Column ${index} of ${total}`} data-testid="board-column-position" className="flex items-center justify-center gap-2.5 pb-1 pt-2.5">
      <span aria-hidden className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            data-current={i + 1 === index || undefined}
            className={cn("h-1.5 rounded-full transition-all duration-200", i + 1 === index ? "w-4 bg-[var(--accent)]" : "w-1.5 bg-[var(--fill-primary)]")}
          />
        ))}
      </span>
      <span aria-hidden className="text-[12px] font-medium tabular-nums text-[var(--text-tertiary)]">
        {index} / {total}
      </span>
    </div>
  )
}
