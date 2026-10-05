import { useState } from "react"
import { FolderKanban } from "lucide-react"
import { resolveProject, useProjects } from "@/hooks/use-projects"
import type { ProjectWire } from "@/lib/project-api"
import { PickerNote, PickerRow, PickerPopover, PickerSheet } from "../pickers/picker-shell"
import { PropertyChip } from "../pickers/property-chip"
import { splitProjectChoices } from "./project-choices"

/* The create dialog's Project chip: which project a new top-level Todo starts
 * in, or none. Only live projects are offered; an archived one is no place to
 * start new work. The dialog hides this chip for a sub-task, which follows its
 * root's project. */

/** The project a create is seeded with: a board filtered to one project starts there; "none" or no filter starts company-level. */
export function seededProject(filter: string | undefined): string | null {
  return filter && filter !== "none" ? filter : null
}

function ProjectPickerContent({ projects, current, sheet, commit, onDone }: {
  projects: ProjectWire[]
  current: string | null
  sheet: boolean
  commit: (project: string | null) => void
  onDone: () => void
}) {
  const pick = (project: string | null) => () => {
    commit(project)
    onDone()
  }
  return (
    <>
      <PickerRow sheet={sheet} label={<span className="text-[var(--text-tertiary)]">No project</span>} checked={current === null} onSelect={pick(null)} testId="project-option-none" />
      {projects.map((project) => (
        <PickerRow key={project.id} sheet={sheet} label={project.name} checked={current === project.id} onSelect={pick(project.id)} testId={`project-option-${project.id}`} />
      ))}
      {projects.length === 0 && <PickerNote>No projects yet. Create one on the Projects page.</PickerNote>}
    </>
  )
}

export function NewTodoProjectChip({ value, onChange, mobile }: {
  value: string | null
  onChange: (project: string | null) => void
  mobile: boolean
}) {
  const [open, setOpen] = useState(false)
  // The registry is read once there is something to show it for: an open picker, or a seeded value that needs its name.
  const projects = useProjects(open || value !== null)
  const { live } = splitProjectChoices(projects.data)
  const close = () => setOpen(false)
  const content = (sheet: boolean) => (
    <ProjectPickerContent projects={live} current={value} sheet={sheet} commit={onChange} onDone={close} />
  )
  const current = resolveProject(projects.data, value ?? undefined)
  return (
    <PropertyChip
      icon={<FolderKanban size={13} aria-hidden />}
      label={current?.name ?? "Project"}
      testId="todo-new-project-chip"
      active={open}
      onClick={() => setOpen((shown) => !shown)}
    >
      {open && !mobile && (
        <PickerPopover label="Project" onClose={close} currentIndex={value ? Math.max(0, live.findIndex((p) => p.id === value)) + 1 : 0} testId="todo-new-project-picker">
          {content(false)}
        </PickerPopover>
      )}
      {open && mobile && (
        <PickerSheet title="Project" onClose={close} testId="todo-new-project-sheet">
          {content(true)}
        </PickerSheet>
      )}
    </PropertyChip>
  )
}
