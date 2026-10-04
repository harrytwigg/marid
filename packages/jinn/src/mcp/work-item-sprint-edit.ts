import { gatewayRequest, JinnMcpToolError, type JinnMcpContext } from "./toolkit.js";
import { gatewayFailure, mutationResult } from "./work-item-result.js";

/**
 * edit_work_item with a `sprint`: a content edit (PATCH) and a sprint move
 * (PUT /api/work-items/:id/sprint) in one call. The move goes first, because it
 * is the half that can be refused (an unknown or closed sprint, a sub-task, no
 * standing), so a refusal saves nothing; the content edit then reads the
 * version the move left. If the move lands and the edit after it fails, the
 * error says the move landed rather than reporting the whole call as failed.
 */
export async function editWithSprintMove(
  ctx: JinnMcpContext,
  id: string,
  sprint: string | null,
  patch: Record<string, unknown>,
  edit: (patch: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const moved = await gatewayRequest(ctx, "PUT", `/api/work-items/${encodeURIComponent(id)}/sprint`, { sprint });
  if (moved.status >= 400) throw gatewayFailure(`moving work item "${id}" to a sprint (nothing was saved)`, moved.status, moved.body);
  const movedBody = moved.body as Record<string, unknown>;
  if (Object.keys(patch).length === 0) return mutationResult(movedBody, "Todo moved; its sub-tasks follow its sprint.");
  try {
    const edited = (await edit(patch)) as Record<string, unknown>;
    return mutationResult({ ...edited, sprint: movedBody.sprint }, "Todo edited and moved; its sub-tasks follow its sprint.");
  } catch (err) {
    const ref = movedBody.sprint as { name?: string } | null;
    const where = ref?.name ? `sprint "${ref.name}"` : "no sprint";
    throw new JinnMcpToolError(`Todo ${id} was moved to ${where}; the content edit then failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
