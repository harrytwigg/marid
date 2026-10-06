import { addAttachment, stageAttachmentBuffer } from "../../work-items/attachments.js";
import type { WorkItem } from "../../work-items/store.js";
import type { Session } from "../../shared/types.js";
import { as } from "./department-scope-harness.js";

/**
 * The cases the allow/refuse matrix drives (FR-010 to FR-019): for every row of
 * `SCOPED_ROUTES`, a request inside department D and the status the route gives it, and
 * a request that reaches outside D and how it is refused.
 *
 * A Todo or session row refuses with a 404 equal, status and body, to the same route's
 * answer for an id that does not exist; a member, skill or path row refuses with a 403
 * naming the reason; a list row narrows.
 */

export type Req = [method: string, url: string, body?: unknown];

export type Refusal =
  /** The same status and body as `like`, the same request for an id that does not exist; `ids` are masked before comparing. */
  | { kind: "unknown"; req: Req; like: Req; ids: [string, string]; status?: number }
  | { kind: "forbidden"; req: Req; reason: RegExp }
  | { kind: "narrowed"; req: Req; check: (body: any) => void };

export interface MatrixCase {
  allow: Req;
  /** What the route answers a request in D; "open" is any answer that the gate did not give. */
  allowStatus: number | "open";
  refuse: Refusal | Refusal[];
}

export interface Fx {
  self: Session;
  peer: Session;
  coo: Session;
  /** A session of eng-dev, who is unscoped. */
  eng: Session;
  /** A Note in side-project's folder, and one in the company's. */
  note: { path: string; revision: string };
  companyNote: { path: string };
  /** A fresh Todo in D, assigned to side-dev (the caller) unless `assignee` says otherwise, so the route's own standing rules pass. */
  mine(assignee?: string | null): WorkItem;
  /** A fresh Todo in the open `engineering` department. */
  theirs(): WorkItem;
  workdirFile: string;
}

export type CaseBuilder = (fx: Fx) => MatrixCase | Promise<MatrixCase>;

export const unknownOf = (id: string) => id.replace(/\d+$/, "99999");

function unknownRefusal(theirs: WorkItem, at: (id: string) => Req, status?: number): Refusal {
  const unknown = unknownOf(theirs.id);
  return { kind: "unknown", req: at(theirs.id), like: at(unknown), ids: [theirs.id, unknown], ...(status ? { status } : {}) };
}

/** A per-Todo row: the request on a Todo outside D is refused as the request on an unknown one. */
export function perTodo(allowStatus: MatrixCase["allowStatus"], at: (id: string, item: WorkItem) => Req): CaseBuilder {
  return (fx) => {
    const mine = fx.mine();
    const theirs = fx.theirs();
    return { allow: at(mine.id, mine), allowStatus, refuse: unknownRefusal(theirs, (id) => at(id, theirs)) };
  };
}

export const todoRoute = (method: string, suffix: string, allowStatus: MatrixCase["allowStatus"], body?: unknown): CaseBuilder =>
  perTodo(allowStatus, (id) => [method, `/api/work-items/${id}${suffix}`, body]);

/** An attachment on `item`, uploaded by side-dev. */
export function seedAttachment(item: WorkItem, employee = "side-dev"): string {
  const stagedPath = stageAttachmentBuffer(Buffer.from(`attachment ${item.id}`));
  return addAttachment({ workItemId: item.id, commentId: null, filename: "a.txt", mime: "text/plain", stagedPath, uploader: { author: employee, authorKind: "employee", operator: false } }).id;
}

export async function seedComment(fx: Fx, item: WorkItem): Promise<string> {
  const made = await as(fx.self.id)("POST", `/api/work-items/${item.id}/comments`, { body: "first" });
  return made.body.comment.id;
}
