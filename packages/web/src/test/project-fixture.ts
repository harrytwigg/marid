import type { ProjectWire } from "@/lib/project-api"

/** A project as the registry returns it, with invented names for tests. */
export function makeProject(over: Partial<ProjectWire> & { id: string; name: string }): ProjectWire {
  return {
    archived: false,
    known: true,
    description: "",
    dedicated: false,
    instructions: "project",
    workdirs: [],
    skills: [],
    sharedNotes: [],
    members: [],
    todoCount: 0,
    spendUsd: 0,
    file: `projects/${over.id}.yaml`,
    notices: [],
    ...over,
  }
}

export const GARDEN = makeProject({
  id: "prj_garden000001",
  name: "Garden Planner",
  description: "Plan the allotment",
  todoCount: 3,
  spendUsd: 1.5,
  file: "projects/garden-planner.yaml",
  workdirs: ["~/plots/garden"],
  skills: ["watering"],
  sharedNotes: ["knowledge/garden.md"],
})
export const BOAT = makeProject({ id: "prj_boat00000001", name: "Boat Club", file: "projects/boat-club.yaml" })
export const RETIRED = makeProject({ id: "prj_old000000001", name: "Retired Orchard", archived: true })
