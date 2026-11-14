import { getQueueItem } from "./registry.js";
import { logger } from "../shared/logger.js";

/**
 * A queue row's own dispatch, parked until a lane slot claims the row.
 *
 * The slot that runs a row is not the slot that was enqueued for it: slots are
 * interchangeable, and each runs whichever registered row is next by position
 * when its turn comes. So the row carries what its caller is awaiting.
 */
export interface WaitingRow {
  id: string;
  fn: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** The rows of each lane that no slot has claimed yet, in the order they were enqueued. */
export class WaitingRows {
  private lanes = new Map<string, Map<string, WaitingRow>>();

  /** `onSkipped` runs for each row dropped because its durable row can no longer run. */
  constructor(private readonly onSkipped: (row: WaitingRow) => void) {}

  add(lane: string, row: WaitingRow): void {
    const rows = this.lanes.get(lane) ?? new Map<string, WaitingRow>();
    rows.set(row.id, row);
    this.lanes.set(lane, rows);
  }

  /**
   * The row to run next: the pending one with the lowest position. Position is
   * read now, not when the row was enqueued, so a row promoted while it waited
   * is first in line. Rows whose durable row is cancelled or gone are dropped.
   */
  next(lane: string): WaitingRow | undefined {
    let head: WaitingRow | undefined;
    let headPosition = 0;
    for (const row of [...(this.lanes.get(lane)?.values() ?? [])]) {
      const item = getQueueItem(row.id);
      if (item?.status !== "pending") {
        this.skip(lane, row, item ? item.status : "gone");
        continue;
      }
      if (!head || item.position < headPosition) {
        head = row;
        headPosition = item.position;
      }
    }
    return head;
  }

  /** Hand the row to a slot: it is no longer waiting. */
  take(lane: string, row: WaitingRow): void {
    this.lanes.get(lane)?.delete(row.id);
  }

  /**
   * A row that will not start: usually a cancel, but also the last point at
   * which a dispatch can end without a spawn — so it is never silent.
   */
  skip(lane: string, row: WaitingRow, reason: string): void {
    this.take(lane, row);
    logger.warn(`Turn ${row.id} on lane ${lane} skipped: queue row is ${reason}`);
    this.onSkipped(row);
    row.resolve();
  }

  /** Fail the row that has waited longest, for a slot that broke before it could claim one. */
  failOldest(lane: string, error: unknown): void {
    const [row] = this.lanes.get(lane)?.values() ?? [];
    if (!row) return;
    this.take(lane, row);
    this.onSkipped(row);
    row.reject(error);
  }

  /** Drop a lane's bookkeeping once nothing waits on it. */
  forgetIfEmpty(lane: string): void {
    if (this.lanes.get(lane)?.size === 0) this.lanes.delete(lane);
  }
}
