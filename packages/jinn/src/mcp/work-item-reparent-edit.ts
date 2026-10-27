import { gatewayRequest, JinnMcpToolError, type JinnMcpContext } from "./toolkit.js";
import { gatewayFailure, mutationResult } from "./work-item-result.js";
import { requireTodoIdField } from "./work-item-args.js";

/** `parentId` on edit_work_item: a Todo id to make this a sub-task of it, or
 *  null to detach it to a root. Undefined when not passed. */
export function optionalParentRef(args: Record<string, unknown>): string | null | undefined {
  if (args.parentId === undefined) return undefined;
  if (args.parentId === null) return null;
  return requireTodoIdField(args, "parentId");
}

/**
 * edit_work_item with a `parentId`: a reparent (PUT /api/work-items/:id/parent)
 * and a content edit (PATCH) in one call. The reparent goes first, because it is
 * the half that can be refused (a cycle, a closed parent, the depth cap, a
 * department boundary, no standing), so a refusal saves nothing; the content edit
 * then reads the version the reparent left. If the reparent lands and the edit
 * after it fails, the error says the reparent landed.
 */
export async function editWithReparent(
  ctx: JinnMcpContext,
  id: string,
  parentId: string | null,
  patch: Record<string, unknown>,
  edit: (patch: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const moved = await gatewayRequest(ctx, "PUT", `/api/work-items/${encodeURIComponent(id)}/parent`, { parentId });
  if (moved.status >= 400) throw gatewayFailure(`reparenting work item "${id}" (nothing was saved)`, moved.status, moved.body);
  const movedBody = moved.body as Record<string, unknown>;
  const where = parentId ? `a sub-task of ${parentId}` : "a root Todo";
  if (Object.keys(patch).length === 0) return mutationResult(movedBody, `Todo is now ${where}; its sub-tasks moved with it.`);
  try {
    const edited = (await edit(patch)) as Record<string, unknown>;
    return mutationResult({ ...edited, parentId: movedBody.parentId, rootId: movedBody.rootId, depth: movedBody.depth }, `Todo edited and made ${where}.`);
  } catch (err) {
    throw new JinnMcpToolError(`Todo ${id} is now ${where}; the content edit then failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
