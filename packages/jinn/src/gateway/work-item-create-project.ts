import { closedProjectReason, placeNewWorkItemInProject, type ProjectRef } from "../work-items/project-membership.js";
import { getWorkItem } from "../work-items/store.js";
import { PROJECT_ID_PATTERN } from "./project-model.js";
import { projectRefOf } from "./project-registry.js";

/**
 * `project` on POST /api/work-items: a project id, placed inside the create
 * transaction. A sub-task follows its root's project, so it never names one of
 * its own. An archived or unknown project takes no new Todos, and that is
 * checked here, before anything is written.
 */
export function readCreateProject(body: Record<string, unknown>, parentId: string | null): { project?: string; error?: string } {
  if (body.project === undefined || body.project === null) return {};
  if (typeof body.project !== "string" || !PROJECT_ID_PATTERN.test(body.project.trim())) return { error: "project must be a project id (prj_ followed by 12 hex characters)" };
  const parent = parentId === null ? undefined : getWorkItem(parentId);
  if (parent) return { error: `a new sub-task cannot take its own project; sub-tasks follow their top-level Todo, so set the project on ${parent.rootId}` };
  const reason = closedProjectReason(projectRefOf(body.project.trim()));
  return reason ? { error: reason } : { project: body.project.trim() };
}

/** Record the project of a Todo this create just made. Throws, rolling the create back, when it cannot be placed. */
export function placeCreatedInProject(workItemId: string, projectId: string): void {
  placeNewWorkItemInProject(workItemId, projectId, projectRefOf);
}

/** The field Todo payloads carry for the project a create placed the Todo in. */
export function projectRow(projectId: string | undefined): { project: ProjectRef } | Record<string, never> {
  return projectId === undefined ? {} : { project: projectRefOf(projectId) };
}
