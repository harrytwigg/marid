import type { CSSProperties } from "react"
import { deptHue } from "@/components/org/layout/dept-color"
import type { ProjectRefWire } from "@/lib/project-api"

/* The small badge that says which project a Todo belongs to, on the board card
 * and the list row. A company-level Todo (no project) wears nothing. Each
 * project keeps one hue — derived from its id, so a rename does not recolour it —
 * and the S/L per theme follows the org map's department accents, so the tint
 * stays low-saturation and in-palette. An archived project is muted, and an id
 * no definition file names reads as an "unknown project" in the same muted
 * style, because neither is somewhere new work should be going. */

export type ProjectBadgeState = "active" | "archived" | "unknown"

export function projectBadgeState(project: ProjectRefWire): ProjectBadgeState {
  if (!project.known) return "unknown"
  return project.archived ? "archived" : "active"
}

const SHAPE =
  "inline-flex h-4 min-w-0 max-w-full shrink items-center gap-1 rounded-[8px] px-1.5 text-[calc(10.5px*var(--text-scale))] font-medium leading-none"
const TONE: Record<ProjectBadgeState, string> = {
  active:
    "bg-[hsl(var(--project-h)_40%_50%/0.16)] text-[hsl(var(--project-h)_42%_34%)] dark:bg-[hsl(var(--project-h)_38%_56%/0.18)] dark:text-[hsl(var(--project-h)_38%_70%)]",
  archived: "bg-[var(--fill-quaternary)] text-[var(--text-quaternary)]",
  unknown: "bg-[var(--fill-quaternary)] italic text-[var(--text-quaternary)]",
}

export function ProjectBadge({ project, className = "" }: { project: ProjectRefWire | null | undefined; className?: string }) {
  if (!project) return null
  const state = projectBadgeState(project)
  const label = state === "unknown" ? "unknown project" : project.name
  const hint = state === "archived" ? `${project.name} (archived project)` : state === "unknown" ? `${project.id} has no project definition` : project.name
  return (
    <span
      data-testid="project-badge"
      data-project-id={project.id}
      data-project-state={state}
      title={hint}
      style={{ "--project-h": deptHue(project.id) } as CSSProperties}
      className={`${SHAPE} ${TONE[state]} ${className}`}
    >
      {state === "archived" && (
        <span aria-hidden className="size-[5px] flex-none rounded-full bg-[hsl(var(--project-h)_30%_55%/0.5)]" />
      )}
      <span className="truncate">{label}</span>
      {state === "archived" && <span className="flex-none font-normal opacity-80">archived</span>}
    </span>
  )
}
