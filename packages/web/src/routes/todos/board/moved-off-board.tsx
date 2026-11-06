import type { Employee, WorkItemCompactWire } from "@/lib/api"
import { useMovedOffBoard } from "@/hooks/use-moved-off-board"
import { BoardCard } from "./card"

const NOOP = () => {}

/**
 * A board member's own open Todos that have left their boards (the operator assigned them to someone elsewhere): each is
 * still theirs to read, and to comment on where their role allows it, so it stays in view, in its own group, rather than
 * vanishing. The group names no destination. It is absent while there is nothing in it.
 */
export function MovedOffBoard({ byName, onOpen }: { byName: Map<string, Employee>; onOpen: (id: string, item?: WorkItemCompactWire) => void }) {
  const items = useMovedOffBoard()
  if (items.length === 0) return null
  return (
    <section data-testid="moved-off-board" aria-label="Moved off this board" className="flex-none px-[var(--space-3)] pb-1 pt-3 md:px-[var(--space-10)]">
      <h2 className="mb-2 text-[calc(12px*var(--text-scale))] font-semibold text-[var(--text-secondary)]">
        Moved off this board <span className="tabular-nums text-[var(--text-quaternary)]">{items.length}</span>
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((item) => (
          <div key={item.id} className="w-[262px] min-w-[238px] flex-none">
            <BoardCard item={item} byName={byName} expanded={false} onToggleTree={NOOP} onOpen={onOpen} onOpenChild={onOpen} />
          </div>
        ))}
      </div>
    </section>
  )
}
