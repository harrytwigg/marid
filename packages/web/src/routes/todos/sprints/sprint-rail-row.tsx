import { useState } from "react"
import { Flag } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { WorkItemDetailWire } from "@/lib/api"
import type { SprintWire, WorkItemSprintRefWire } from "@/lib/sprint-api"
import { RailRow } from "../task-page/rail-rows"
import { MenuCheck } from "../filter-chips"
import { useSetWorkItemSprint, useSprints, sprintErrorMessage } from "./use-sprints"

/* The task rail's Sprint row: which sprint the Todo is in, and the menu that
 * moves it to another one or out of any. A sub-task has no sprint of its own —
 * it follows its top-level Todo — so its row reads the root's sprint and says
 * so instead of offering a move the gateway would refuse. Closed sprints are
 * history and are never offered as a destination. */

const MENU_CLASS =
  "max-h-[min(420px,70vh)] w-[min(280px,calc(100vw-24px))] overflow-y-auto rounded-[var(--radius-xl)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ITEM_CLASS =
  "min-h-10 cursor-pointer gap-2 rounded-[9px] px-2.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-tertiary)]"

export function SprintRailRow({ detail, editable }: { detail: WorkItemDetailWire; editable: boolean }) {
  const item = detail.workItem
  const current = detail.sprint ?? null
  const followsRoot = item.parentId != null ? item.rootId ?? item.parentId : null
  const [open, setOpen] = useState(false)
  const sprints = useSprints(editable && !followsRoot && open)
  const move = useSetWorkItemSprint()
  const value = <SprintValue current={current} followsRoot={followsRoot} />

  if (!editable || followsRoot) return <RailRow quiet testId="rail-sprint">{value}</RailRow>

  return (
    <div className="relative">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        {/* RailRow passes on no props of its own, so the trigger's handlers ride a
            wrapper: pointer and key events on the row bubble to it. */}
        <DropdownMenuTrigger asChild>
          <div>
            <RailRow quiet testId="rail-sprint" label="Sprint" onOpen={() => {}} open={open}>
              {value}
            </RailRow>
          </div>
        </DropdownMenuTrigger>
        <SprintMoveMenu
          current={current}
          sprints={sprints.isSuccess ? sprints.data.filter((sprint) => sprint.status !== "closed") : undefined}
          onMove={(sprint) => move.mutate({ id: item.id, sprint })}
        />
      </DropdownMenu>
      {move.isError && (
        <div role="alert" className="pt-1 text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {sprintErrorMessage(move.error, "Couldn't move the Todo")}
        </div>
      )}
    </div>
  )
}

function SprintValue({ current, followsRoot }: { current: WorkItemSprintRefWire | null; followsRoot: string | null }) {
  return (
    <>
      <Flag size={14} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
      {current ? (
        <span className="min-w-0 truncate">
          {current.name}
          {current.status !== "planned" && (
            <span className="ml-1.5 text-[12px] font-normal text-[var(--text-quaternary)]">{current.status}</span>
          )}
        </span>
      ) : (
        <span className="text-[var(--text-tertiary)]">No sprint</span>
      )}
      {followsRoot && <span className="ml-1 text-[12px] font-normal text-[var(--text-quaternary)]">· follows {followsRoot}</span>}
    </>
  )
}

/** The menu body; `sprints` is undefined until the registry has loaded. */
function SprintMoveMenu({ current, sprints, onMove }: {
  current: WorkItemSprintRefWire | null
  sprints: SprintWire[] | undefined
  onMove: (sprint: string | null) => void
}) {
  return (
    <DropdownMenuContent align="start" className={MENU_CLASS}>
      <DropdownMenuItem className={ITEM_CLASS} onClick={() => onMove(null)}>
        No sprint<MenuCheck on={current === null} />
      </DropdownMenuItem>
      {(sprints ?? []).map((sprint) => (
        <DropdownMenuItem key={sprint.id} className={ITEM_CLASS} data-testid={`rail-sprint-${sprint.id}`} onClick={() => onMove(sprint.id)}>
          <span className="min-w-0 truncate">{sprint.name}</span>
          <span className="text-[11px] text-[var(--text-quaternary)]">{sprint.status}</span>
          <MenuCheck on={current?.id === sprint.id} />
        </DropdownMenuItem>
      ))}
      {sprints?.length === 0 && (
        <div className="px-2.5 py-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          No open sprints. Create one from the board's Sprint filter.
        </div>
      )}
    </DropdownMenuContent>
  )
}
