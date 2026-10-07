import { createHash } from 'node:crypto';
import type { UpdateWorkItemInput, WorkItem } from './store.js';

/** The metadata pen's columns, and the fingerprint its idempotency receipts key on.
 *  Moved out of `store.ts` to pay for that file's size budget. */
export const UPDATE_FIELD_COLUMNS: Readonly<Record<Exclude<keyof UpdateWorkItemInput, 'startAt'>, string>> = {
  title: 'title',
  body: 'body',
  assignee: 'assignee',
  department: 'department',
  priority: 'priority',
  rank: 'rank',
  // Appended AFTER the original six so pre-slice-4 idempotency-receipt
  // fingerprints (key order feeds the canonical JSON) stay byte-stable.
  dueAt: 'due_at',
};

/** Every field the pen edits, in fingerprint order. `startAt` has no column
 *  (start-date.ts holds it) and is appended last, so a receipt minted before it
 *  existed, which never names it, keeps its fingerprint. */
const UPDATE_FIELDS: ReadonlyArray<keyof UpdateWorkItemInput> = [
  ...(Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof typeof UPDATE_FIELD_COLUMNS>),
  'startAt',
];

export function canonicalUpdateFingerprint(id: string, input: UpdateWorkItemInput, expectedVersion: number): string {
  const patch: Record<string, unknown> = {};
  for (const key of UPDATE_FIELDS) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  return createHash('sha256').update(JSON.stringify({ id, expectedVersion, patch })).digest('hex');
}

export function idempotencyKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function updateChangesItem(item: WorkItem, input: UpdateWorkItemInput): boolean {
  return UPDATE_FIELDS
    .some((key) => {
      if (input[key] === undefined) return false;
      return item[key] !== input[key];
    });
}
