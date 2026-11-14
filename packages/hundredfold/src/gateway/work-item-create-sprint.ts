import { getWorkItem } from "../work-items/store.js";
import { subTaskSprintRefusal, type Sprint, type SprintRef } from "../work-items/sprints.js";

/**
 * `sprint` on POST /api/work-items: the same values PUT /api/work-items/:id/sprint
 * takes (an id, a name, or `active`), placed inside the create transaction. A
 * sub-task follows its root's sprint, so it never names one of its own.
 */
export function readCreateSprint(body: Record<string, unknown>, parentId: string | null): { sprint?: string; error?: string } {
  if (body.sprint === undefined || body.sprint === null) return {};
  if (typeof body.sprint !== "string" || !body.sprint.trim()) return { error: "sprint must be a sprint id or name, or `active`" };
  const parent = parentId === null ? undefined : getWorkItem(parentId);
  if (parent) return { error: subTaskSprintRefusal("a new sub-task cannot take its own sprint", parent.rootId) };
  return { sprint: body.sprint.trim() };
}

/** The row shape Todo payloads carry for a sprint. */
export function sprintRow(sprint: Sprint | null): SprintRef | undefined {
  return sprint ? { id: sprint.id, name: sprint.name, status: sprint.status } : undefined;
}
