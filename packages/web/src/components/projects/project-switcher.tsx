import { Check, ChevronDown, FolderKanban } from "lucide-react"
import { setActiveProject, useActiveProject } from "@/hooks/use-active-project"
import { projectFilterLabel, useProjects } from "@/hooks/use-projects"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/* The project switcher: "All projects" plus each project still in use. It
 * renders nothing when no project exists, so an install that never made one
 * looks exactly as it did before. */

const ITEM_CLASS = "min-h-9 gap-2 text-[length:var(--text-footnote)]"

export function ProjectSwitcher({ className, showIcon = true }: { className?: string; showIcon?: boolean }) {
  const { data: projects } = useProjects()
  const active = useActiveProject()
  if (!projects || projects.length === 0) return null
  const choices = projects.filter((project) => !project.archived || project.id === active)
  const label = projectFilterLabel(active, projects) ?? "All projects"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project: ${label}`}
          title={`Project: ${label}`}
          className={cn(
            "inline-flex min-h-9 max-w-[200px] items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-[length:var(--text-footnote)] " +
              "text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
            className,
          )}
        >
          {showIcon ? <FolderKanban size={15} className="shrink-0" aria-hidden /> : null}
          <span className="truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuItem className={ITEM_CLASS} onSelect={() => setActiveProject(undefined)}>
          <span className="flex-1">All projects</span>
          {active === undefined ? <Check size={14} aria-hidden /> : null}
        </DropdownMenuItem>
        {choices.map((project) => (
          <DropdownMenuItem key={project.id} className={ITEM_CLASS} onSelect={() => setActiveProject(project.id)}>
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {active === project.id ? <Check size={14} aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
