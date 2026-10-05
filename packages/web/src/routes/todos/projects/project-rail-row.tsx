import { useState } from "react"
import { FolderKanban } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { WorkItemDetailWire } from "@/lib/api"
import { useSetTodoProject, useProjects } from "@/hooks/use-projects"
import type { ProjectRefWire, ProjectWire } from "@/lib/project-api"
import { RailRow } from "../task-page/rail-rows"
import { MenuCheck } from "../filter-chips"
import { sprintErrorMessage } from "../sprints/use-sprints"
import { splitProjectChoices } from "./project-choices"

/* The task rail's Project row: which project the Todo is in, and the menu that
 * moves it to another one or out of any. A sub-task has no project of its own —
 * it follows its top-level Todo — so its row reads the root's project and says
 * so instead of offering a move the gateway would refuse. Archived projects are
 * never offered as a destination. */

const MENU_CLASS =
  "max-h-[min(420px,70vh)] w-[min(280px,calc(100vw-24px))] overflow-y-auto rounded-[var(--radius-xl)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ITEM_CLASS =
  "min-h-10 cursor-pointer gap-2 rounded-[9px] px-2.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-tertiary)]"

export function ProjectRailRow({ detail, editable }: { detail: WorkItemDetailWire; editable: boolean }) {
  const item = detail.workItem
  const current = detail.project ?? null
  const followsRoot = item.parentId != null ? item.rootId ?? item.parentId : null
  const [open, setOpen] = useState(false)
  const projects = useProjects(editable && !followsRoot && open)
  const move = useSetTodoProject()
  const value = <ProjectValue current={current} followsRoot={followsRoot} />

  if (!editable || followsRoot) return <RailRow quiet testId="rail-project">{value}</RailRow>

  return (
    <div className="relative">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        {/* RailRow passes on no props of its own, so the trigger's handlers ride a
            wrapper: pointer and key events on the row bubble to it. */}
        <DropdownMenuTrigger asChild>
          <div>
            <RailRow quiet testId="rail-project" label="Project" onOpen={() => {}} open={open}>
              {value}
            </RailRow>
          </div>
        </DropdownMenuTrigger>
        <ProjectMoveMenu
          current={current}
          projects={projects.isSuccess ? splitProjectChoices(projects.data).live : undefined}
          onMove={(project) => move.mutate({ id: item.id, project })}
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

function ProjectName({ current }: { current: ProjectRefWire }) {
  if (!current.known) return <span className="italic text-[var(--text-tertiary)]">unknown project</span>
  return (
    <span className="min-w-0 truncate">
      {current.name}
      {current.archived && <span className="ml-1.5 text-[12px] font-normal text-[var(--text-quaternary)]">archived</span>}
    </span>
  )
}

function ProjectValue({ current, followsRoot }: { current: ProjectRefWire | null; followsRoot: string | null }) {
  return (
    <>
      <FolderKanban size={14} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
      {current ? <ProjectName current={current} /> : <span className="text-[var(--text-tertiary)]">No project</span>}
      {followsRoot && (
        <span
          title="A sub-task is in its top-level Todo's project. Move that Todo to change it."
          className="ml-1 text-[12px] font-normal text-[var(--text-quaternary)]"
        >
          · follows {followsRoot}
        </span>
      )}
    </>
  )
}

/** The menu body; `projects` is undefined until the registry has loaded. */
function ProjectMoveMenu({ current, projects, onMove }: {
  current: ProjectRefWire | null
  projects: ProjectWire[] | undefined
  onMove: (project: string | null) => void
}) {
  return (
    <DropdownMenuContent align="start" className={MENU_CLASS}>
      <DropdownMenuItem className={ITEM_CLASS} data-testid="rail-project-none" onClick={() => onMove(null)}>
        No project<MenuCheck on={current === null} />
      </DropdownMenuItem>
      {(projects ?? []).map((project) => (
        <DropdownMenuItem key={project.id} className={ITEM_CLASS} data-testid={`rail-project-${project.id}`} onClick={() => onMove(project.id)}>
          <span className="min-w-0 truncate">{project.name}</span>
          <MenuCheck on={current?.id === project.id} />
        </DropdownMenuItem>
      ))}
      {projects?.length === 0 && (
        <div className="px-2.5 py-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          No projects yet. Create one on the Projects page.
        </div>
      )}
    </DropdownMenuContent>
  )
}
