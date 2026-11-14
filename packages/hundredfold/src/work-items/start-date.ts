import type { Database as DatabaseType } from "better-sqlite3";

/** A Todo's start date: the moment before which nothing starts it.
 *
 *  It sits beside the due date as a plain field (`startAt`, an ISO instant),
 *  but it is not a column on `work_items`: the exact-shape verifier refuses
 *  any drift in an existing table, so an additive table is the only extension
 *  a deployed database survives, and an older build simply ignores it. A row
 *  exists only while a start date is set; clearing one deletes the row.
 *
 *  It gates a first start, not status. The Todo Dispatcher refuses a backlog
 *  Todo whose start date is still ahead (so the Dispatch button and the board
 *  walk hold it), and the board walk shows the date and refuses the start with
 *  the date named. Nothing moves the Todo: it waits in its column, and becomes
 *  startable the moment the date passes. Work already under way is restarted
 *  whatever its start date says (startDateHold). */
export const WORK_ITEM_START_DATES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_start_dates (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  start_at     TEXT NOT NULL
)`;

export const WORK_ITEM_START_DATES_DDL = `
${WORK_ITEM_START_DATES_TABLE_DDL};
`;

/** The `start_at` select-list term every Todo read carries, so `startAt` is on
 *  the row like `dueAt` rather than a second lookup per Todo. */
export const START_AT_COLUMN_SQL =
  "(SELECT sd.start_at FROM work_item_start_dates sd WHERE sd.work_item_id = work_items.id) AS start_at";

/** Set (an ISO instant) or clear (null) a Todo's start date. */
export function writeWorkItemStartAt(db: DatabaseType, workItemId: string, startAt: string | null): void {
  if (startAt === null) {
    db.prepare("DELETE FROM work_item_start_dates WHERE work_item_id = ?").run(workItemId);
    return;
  }
  db.prepare(
    `INSERT INTO work_item_start_dates (work_item_id, start_at) VALUES (?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET start_at = excluded.start_at`,
  ).run(workItemId, startAt);
}

/** Boot verification: every row belongs to a live Todo and holds a date. */
export function startDateRowsAreSound(db: DatabaseType, isLiveTodo: (id: string) => boolean): boolean {
  const rows = db.prepare("SELECT work_item_id, start_at FROM work_item_start_dates").all() as Array<{
    work_item_id: string;
    start_at: string;
  }>;
  return rows.every((row) => isLiveTodo(row.work_item_id) && Number.isFinite(Date.parse(row.start_at)));
}

/** A start date after the due date: a Todo that may not start until after it
 *  is due is a contradiction, so the write is refused rather than stored. */
export class TodoDateOrderError extends Error {
  constructor(startAt: string, dueAt: string) {
    super(`startAt (${startAt}) must not be after dueAt (${dueAt})`);
    this.name = "TodoDateOrderError";
  }
}

/** A start date as the store keeps it: an ISO instant, or none. Every writer
 *  comes through here, plugins included, so a value that does not parse is
 *  refused at the write rather than stored for the boot verifier to refuse. */
export function startAtInstant<T extends string | null | undefined>(value: T): T | string {
  if (typeof value !== "string") return value;
  const at = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || !Number.isFinite(at)) throw new Error("startAt must be an ISO 8601 timestamp or null");
  return new Date(at).toISOString();
}

export function assertTodoDateOrder(startAt: string | null | undefined, dueAt: string | null | undefined): void {
  if (startAt && dueAt && Date.parse(startAt) > Date.parse(dueAt)) throw new TodoDateOrderError(startAt, dueAt);
}

/** The metadata pen's half for the start date, inside its transaction: refuse
 *  a result whose start is after its due date, then write the start date if the
 *  edit names one. True when it did, for the edit's `updatedFields`. */
export function applyStartAtEdit(
  db: DatabaseType,
  current: { id: string; startAt: string | null; dueAt: string | null },
  input: { startAt?: string | null; dueAt?: string | null },
): boolean {
  if (input.startAt === undefined && input.dueAt === undefined) return false;
  const startAt = startAtInstant(input.startAt);
  assertTodoDateOrder(startAt !== undefined ? startAt : current.startAt, input.dueAt !== undefined ? input.dueAt : current.dueAt);
  if (startAt === undefined) return false;
  writeWorkItemStartAt(db, current.id, startAt);
  return true;
}

/** Why a Todo may not be started yet, or undefined once its start date has
 *  passed (or it has none). Only a first start is held: a Todo out of
 *  `backlog` is already under way (a delegation or a wake may have begun it
 *  before the date was set), and refusing its restart after a rate limit would
 *  strand it `executing` with nothing running once the resume sweep gives up. */
export function startDateHold(item: { id: string; status: string; startAt: string | null }, now: number): string | undefined {
  if (!item.startAt || item.status !== "backlog") return undefined;
  const at = Date.parse(item.startAt);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return `Todo ${item.id} has a start date of ${item.startAt} and is not started before it; clear or move the start date to start it sooner`;
}
