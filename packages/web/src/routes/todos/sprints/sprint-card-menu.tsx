import { useCallback, useMemo, useState } from "react"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  PointMenu,
} from "@/components/ui/context-menu"
import type { WorkItemCompactWire } from "@/lib/api"
import type { SprintWire } from "@/lib/sprint-api"
import { MenuCheck } from "../filter-chips"
import { keptByClosedSprint, useSetWorkItemSprint } from "./use-sprints"

/* Right-click a board card to move it into a sprint, between sprints, or out of
 * one — the way planning a sprint goes, card by card, without opening each
 * Todo. Desktop only: on a phone a long press belongs to the drag, and the task
 * page's Sprint row is the way there. The board shows top-level Todos only, so
 * every card here is one the gateway lets move.
 *
 * ONE menu for the whole board, opened at the pointer, rather than a context
 * menu wrapped around each card: a per-card wrapper re-rendered every card on
 * unrelated page state, which the board's render-cost budget forbids. */

const MENU_CLASS =
  "min-w-[220px] rounded-[var(--radius-xl)] p-1.5"
const ITEM_CLASS =
  "min-h-9 cursor-pointer gap-2 rounded-[9px] px-2.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-tertiary)]"

interface MenuTarget {
  item: WorkItemCompactWire
  x: number
  y: number
  /** Bumped per right-click: each open mounts a fresh menu, measured at its own
   *  pointer, rather than reusing the one still anchored where the last one was. */
  seq: number
}

/** `onContextMenu` goes on the element holding the cards; `menu` renders anywhere. */
export function useSprintCardMenu({ itemById, sprints, enabled, onError }: {
  itemById: (id: string) => WorkItemCompactWire | undefined
  /** The open sprints a card may move to (closed ones are history). */
  sprints: SprintWire[]
  enabled: boolean
  onError: (error: unknown) => void
}) {
  const [target, setTarget] = useState<MenuTarget | null>(null)
  const move = useSetWorkItemSprint()

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    if (!enabled) return
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-board-card]")
    const item = card ? itemById(card.dataset.boardCard ?? "") : undefined
    // Anywhere but a card keeps the browser's own menu.
    if (!item) return
    event.preventDefault()
    setTarget((last) => ({ item, x: event.clientX, y: event.clientY, seq: (last?.seq ?? 0) + 1 }))
  }, [enabled, itemById])

  const moveTo = (sprint: string | null) => {
    if (!target || sprint === currentSprintOf(target)) return
    move.mutate({ id: target.item.id, sprint }, { onError })
  }

  const menu = target
    ? <SprintCardMenu key={target.seq} target={target} sprints={sprints} onClose={() => setTarget(null)} onMove={moveTo} />
    : null
  return { onContextMenu, menu }
}

function SprintCardMenu({ target, sprints, onClose, onMove }: {
  target: MenuTarget
  sprints: SprintWire[]
  onClose: () => void
  onMove: (sprint: string | null) => void
}) {
  const current = currentSprintOf(target)
  const kept = keptByClosedSprint(target.item.status, target.item.sprint)
  const point = useMemo(() => ({ x: target.x, y: target.y }), [target.x, target.y])
  return (
    <PointMenu point={point} onOpenChange={(open) => { if (!open) onClose() }}>
      <ContextMenuContent aria-label={`Move ${target.item.id} to a sprint`} className={MENU_CLASS} data-testid="sprint-card-menu">
        <ContextMenuLabel className="px-2.5 pb-1 pt-1.5 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
          Move {target.item.id} to sprint
        </ContextMenuLabel>
        {kept && (
          <ContextMenuLabel
            data-testid="sprint-card-kept"
            className="max-w-[240px] px-2.5 pb-1.5 pt-0 text-[length:var(--text-caption1)] font-normal text-[var(--text-tertiary)]"
          >
            {target.item.status === "done" ? "Done" : "Cancelled"} in closed sprint {target.item.sprint?.name}, which keeps it as its record.
          </ContextMenuLabel>
        )}
        {sprints.map((sprint) => (
          <ContextMenuItem key={sprint.id} className={ITEM_CLASS} disabled={kept} data-testid={`sprint-card-move-${sprint.id}`} onSelect={() => onMove(sprint.id)}>
            <span className="min-w-0 truncate">{sprint.name}</span>
            <span className="text-[11px] text-[var(--text-quaternary)]">{sprint.status}</span>
            <MenuCheck on={current === sprint.id} />
          </ContextMenuItem>
        ))}
        {sprints.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem className={ITEM_CLASS} disabled={kept} data-testid="sprint-card-move-none" onSelect={() => onMove(null)}>
          No sprint
          <MenuCheck on={current === null} />
        </ContextMenuItem>
      </ContextMenuContent>
    </PointMenu>
  )
}

function currentSprintOf(target: MenuTarget | null): string | null {
  return target?.item.sprint?.id ?? null
}
