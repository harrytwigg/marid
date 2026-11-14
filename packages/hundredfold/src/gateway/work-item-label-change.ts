import {
  addWorkItemLabels,
  removeWorkItemLabels,
  setWorkItemLabels,
  TODO_LABELS_MAX,
  type Label,
  type LabelChangeMode,
} from "../work-items/labels.js";
import type { WriteOrigin } from "../work-items/origin.js";

/**
 * The body of `PUT /api/work-items/:id/labels`, parsed and applied.
 *
 * `labels` is the whole set and replaces it — the label editor's contract, and
 * what every caller holding a complete set sends. `add` and `remove` name only
 * the labels that change, which is what an agent asked to drop one label needs:
 * with replace as the only shape, dropping one means reconstructing the rest
 * from memory, and a Todo that loses its arming label that way can never fire
 * its lane trigger again.
 *
 * It sits beside the route rather than inside it because it is a body grammar
 * with rules of its own, and the route is already the longest file in the tree.
 */

const MODES: Record<string, LabelChangeMode> = { labels: "replace", add: "add", remove: "remove" };
const LABEL_REF_CHAR_CAP = 256;

export type LabelChange = { mode: LabelChangeMode; refs: string[] } | { error: string };

/** Why these refs cannot be used, or undefined when they can. */
function refRefusal(key: string, refs: unknown): string | undefined {
  if (!Array.isArray(refs) || refs.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > LABEL_REF_CHAR_CAP)) {
    return `${key} must be an array of label ids or names (non-empty strings)`;
  }
  if (refs.length > TODO_LABELS_MAX) {
    return `${key} accepts at most ${TODO_LABELS_MAX} entries per Todo (got ${refs.length})`;
  }
  // An empty `labels` is a deliberate clear; an empty `add`/`remove` names nothing
  // to change, which is a caller that has lost track of what it meant to send.
  if (key !== "labels" && refs.length === 0) {
    return `${key} must name at least one label — an empty ${key} would change nothing`;
  }
  return undefined;
}

export function parseLabelChange(body: unknown): LabelChange {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "request body must be a JSON object" };
  const record = body as Record<string, unknown>;
  const named = Object.keys(MODES).filter((key) => record[key] !== undefined);
  if (named.length !== 1) {
    return { error: "pass exactly one of labels (the whole set), add, or remove"
      + `${named.length > 1 ? ` — ${named.join(" and ")} were sent together` : ""}` };
  }
  const key = named[0]!;
  const refusal = refRefusal(key, record[key]);
  if (refusal !== undefined) return { error: refusal };
  return { mode: MODES[key]!, refs: (record[key] as string[]).map((entry) => entry.trim()) };
}

export function applyLabelChange(workItemId: string, change: { mode: LabelChangeMode; refs: string[] },
  actor: string, origin?: WriteOrigin): Label[] {
  if (change.mode === "add") return addWorkItemLabels(workItemId, change.refs, actor, origin);
  if (change.mode === "remove") return removeWorkItemLabels(workItemId, change.refs, actor, origin);
  return setWorkItemLabels(workItemId, change.refs, actor, origin);
}
