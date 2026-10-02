import { BLOCK_KIND_ERROR, parseBlockKind, type BlockKind } from "../work-items/blocks.js";
import {
  UNBLOCK_HINT_ERROR,
  parkRefusal,
  parseParkedUntil,
  parseUnblockHint,
  type TodoStopCause,
} from "../work-items/stop-cause.js";

/**
 * The status route's body fields, read once and validated together.
 *
 * They are the parts of `POST|PUT /api/work-items/:id/status` that say HOW a
 * move was meant rather than where it goes: the reason, the kind of block, and
 * the two authority flags. The route keeps the lifecycle decisions; this keeps
 * the reading of them out of a handler already long enough to hide one.
 */

export interface StatusUpdateFields {
  /** Trimmed; empty when absent. */
  note: string;
  blockKind: BlockKind | undefined;
  /** Undefined when the move names neither a park nor a hint. */
  stopCause: TodoStopCause | undefined;
  asOperator: boolean;
  cascade: boolean;
}

export type StatusUpdateFieldsResult =
  | ({ ok: true } & StatusUpdateFields)
  | { ok: false; status: number; error: string };

type Refusal = { ok: false; status: number; error: string };

function refuse(status: number, error: string): Refusal {
  return { ok: false, status, error };
}

/** `asOperator`, `cascade` — who a move is recorded as, and how far it
 *  reaches. Their authority is the route's to grant, but the shape and the two
 *  rules that make a cascade meaningless are checked here. */
function parseAuthorityFlags(
  body: Record<string, unknown>,
  target: string,
  operatorLane: boolean,
): Pick<StatusUpdateFields, "asOperator" | "cascade"> | Refusal {
  for (const key of ["asOperator", "cascade"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return refuse(400, `${key} must be a boolean`);
  }
  const cascade = body.cascade === true;
  if (cascade && target !== "done") {
    return refuse(400, "cascade closes a Todo's open descendants and applies to a done update only");
  }
  // A cascade closes work its caller never looked at, so it rides on the human
  // surface — the same authority archive's cascade-cancel asks for. Refused
  // outright rather than dropped, because dropping it would report success for
  // children that are still open. `asOperator` does not reach it either: the
  // coordinator closes the one Todo it was asked about, while a cascade decides
  // a whole subtree it has not looked at, so the subtree stays with the human.
  if (cascade && !operatorLane) {
    return refuse(403, "closing a Todo's open descendants with it is an operator-surface decision");
  }
  return { asOperator: body.asOperator === true, cascade };
}

/** The park, if the move can hold one. A park only survives a move that stops
 *  the Todo: everywhere else transition() deletes it with the write,
 *  so it is refused rather than reported as a park that is gone before the
 *  response is sent. `dependency` routes a block back to the queue, so it
 *  cannot carry one either. */
function parsePark(body: Record<string, unknown>, target: string, blockKind: BlockKind | undefined): string | undefined | Refusal {
  const refused = parkRefusal(body.parkedUntil, target, blockKind);
  return refused ? refuse(400, refused) : parseParkedUntil(body.parkedUntil) ?? undefined;
}

/** The stop's cause (PLA-157): when a clock-wait ends, or what has to happen
 *  and who has to do it. Optional; validated here so the route and the MCP tool
 *  refuse the same malformed shapes. */
function parseStopCause(
  body: Record<string, unknown>,
  target: string,
  blockKind: BlockKind | undefined,
): { stopCause: TodoStopCause | undefined } | Refusal {
  const unblockHint = parseUnblockHint(body.unblockHint);
  if (unblockHint === null) return refuse(400, UNBLOCK_HINT_ERROR);
  const parkedUntil = parsePark(body, target, blockKind);
  if (typeof parkedUntil === "object") return parkedUntil;
  if (!unblockHint && !parkedUntil) return { stopCause: undefined };
  return { stopCause: { ...(parkedUntil ? { parkedUntil } : {}), ...(unblockHint ? { unblockHint } : {}) } };
}

export function parseStatusUpdateFields(
  body: Record<string, unknown>,
  target: string,
  operatorLane: boolean,
): StatusUpdateFieldsResult {
  const note = typeof body.note === "string" ? body.note.trim() : "";
  // Agents must say WHY up front; the operator surface asks for the reason
  // in the opened item's banner instead (design-doc §5) — never a modal.
  if (target === "blocked" && !note && !operatorLane) return refuse(400, `note is required when moving a Todo to ${target}`);
  // The kind decides where a block lands, so an unknown one refuses rather than falling back to a default nobody meant.
  const blockKind = parseBlockKind(body.blockKind);
  if (blockKind === null) return refuse(400, BLOCK_KIND_ERROR);
  const cause = parseStopCause(body, target, blockKind);
  if ("ok" in cause) return cause;
  const flags = parseAuthorityFlags(body, target, operatorLane);
  if ("ok" in flags) return flags;
  return { ok: true, note, blockKind, ...cause, ...flags };
}
