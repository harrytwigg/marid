import type { ProjectWire } from "@/lib/project-api"

/** The projects a picker lists: live ones by name first, archived ones after
 *  (a filter still offers them so an old project's Todos stay reachable; a place
 *  to put new work never does). */
export function splitProjectChoices(projects: ProjectWire[] | undefined): { live: ProjectWire[]; archived: ProjectWire[] } {
  const byName = (a: ProjectWire, b: ProjectWire) => a.name.localeCompare(b.name)
  const all = projects ?? []
  return {
    live: all.filter((project) => !project.archived).sort(byName),
    archived: all.filter((project) => project.archived).sort(byName),
  }
}
