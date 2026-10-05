import { useActiveProject, setActiveProject } from "@/hooks/use-active-project"
import { projectFilterLabel, useProjects } from "@/hooks/use-projects"
import { ProjectSwitcher } from "./project-switcher"
import { useProjectScope } from "./use-project-scope"

/* The chat list's project row: the switcher, and, while a project narrows the
 * list, a plain statement of that with a way back. Nothing without projects. */

export function SidebarProjectBar() {
  const { data: projects } = useProjects()
  const active = useActiveProject()
  const { projectId } = useProjectScope()
  if (!projects || projects.length === 0) return null
  return (
    <div data-testid="sidebar-project-bar" className="flex shrink-0 items-center gap-1 px-3 pb-2">
      {projectId ? (
        <>
          <span className="min-w-0 truncate text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
            Showing project {projectFilterLabel(active, projects)}
          </span>
          <span aria-hidden className="text-[var(--text-quaternary)]">·</span>
          <button
            type="button"
            onClick={() => setActiveProject(undefined)}
            className="shrink-0 text-[length:var(--text-caption1)] text-[var(--accent)] hover:underline"
          >
            clear
          </button>
          <span className="flex-1" />
        </>
      ) : null}
      <ProjectSwitcher showIcon={!projectId} className={projectId ? "ml-auto" : ""} />
    </div>
  )
}
