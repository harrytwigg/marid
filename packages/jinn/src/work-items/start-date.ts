import type { Database as DatabaseType } from "better-sqlite3";

/** A Todo's start date: the moment before which nothing starts it.
 *
 *  It sits beside the due date as a plain field (`startAt`, an ISO instant),
 *  but it is not a column on `work_items`: the exact-shape verifier refuses
 *  any drift in an existing table, so an additive table is the only extension
 *  a deployed database survives, and an older build simply ignores it. A row
 *  exists only while a start date is set; clearing one deletes the row.
 *
 *  It gates starts, not status. The Todo Dispatcher refuses a Todo whose start
 *  date is still ahead (so the Dispatch button, the board walk and the stall
 *  sweep all hold it), and the board walk shows the date and refuses the start
 *  with the date named. Nothing moves the Todo: it waits in its column, and
 *  becomes startable the moment the date passes. */
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
  assertTodoDateOrder(input.startAt !== undefined ? input.startAt : current.startAt, input.dueAt !== undefined ? input.dueAt : current.dueAt);
  if (input.startAt === undefined) return false;
  writeWorkItemStartAt(db, current.id, input.startAt);
  return true;
}

/** Why a Todo may not be started yet, or undefined once its start date has
 *  passed (or it has none). Every automatic and manual start path reads this. */
export function startDateHold(item: { id: string; startAt: string | null }, now: number): string | undefined {
  if (!item.startAt) return undefined;
  const at = Date.parse(item.startAt);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return `Todo ${item.id} has a start date of ${item.startAt} and is not started before it; clear or move the start date to start it sooner`;
}
