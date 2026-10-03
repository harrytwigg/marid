import { useCallback, useMemo, useState } from "react"
import type { WorkItemStatusWire } from "@/lib/api"
import { operatorSafeTodoError, type TodoFilters } from "@/lib/todos"
import type { BoardColumnData } from "../board/use-board"
import { BOARD_STATUS_ORDER } from "../board/status-scope"
import { useSprintCardMenu } from "./sprint-card-menu"
import { SprintStrip } from "./sprint-strip"
import { SprintsDialog } from "./sprints-dialog"
import { useSprints } from "./use-sprints"

/* Everything the board needs for sprints, in one place: the strip under the
 * filter row while a sprint filter is set, the planner dialog, and the card
 * menu that moves a Todo between sprints. The board mounts `strip` and
 * `overlays`, hands `openPlanner` to its filter controls, and puts
 * `onContextMenu` on the element holding the cards. */

export function useBoardSprints({ filters, setFilters, columns, mobile, announce }: {
  filters: TodoFilters
  setFilters: (next: TodoFilters) => void
  columns: Record<WorkItemStatusWire, BoardColumnData>
  mobile: boolean
  announce: (message: string) => void
}) {
  const [planner, setPlanner] = useState<null | { completing?: string }>(null)
  const sprints = useSprints(!mobile)
  const openSprints = useMemo(() => (sprints.data ?? []).filter((sprint) => sprint.status !== "closed"), [sprints.data])
  const onMoveError = useCallback(
    (error: unknown) => announce(operatorSafeTodoError(error, "The gateway refused to move the Todo to that sprint")),
    [announce],
  )
  const itemById = useCallback((id: string) => {
    for (const status of BOARD_STATUS_ORDER) {
      const found = columns[status]?.items.find((item) => item.id === id)
      if (found) return found
    }
    return undefined
  }, [columns])
  const cardMenu = useSprintCardMenu({ itemById, sprints: openSprints, enabled: !mobile, onError: onMoveError })
  const openPlanner = useCallback(() => setPlanner({}), [])

  const strip = filters.sprint
    ? <SprintStrip filter={filters.sprint} onManage={openPlanner} onComplete={(id) => setPlanner({ completing: id })} />
    : null
  const overlays = (
    <>
      {cardMenu.menu}
      <SprintsDialog
        open={planner !== null}
        onOpenChange={(open) => { if (!open) setPlanner(null) }}
        completing={planner?.completing ?? null}
        onShowOnBoard={(sprintId) => {
          setPlanner(null)
          setFilters({ ...filters, sprint: sprintId })
        }}
      />
    </>
  )
  return { strip, overlays, openPlanner, onContextMenu: cardMenu.onContextMenu }
}
