import { getQueueItem, markQueueItemRunning, markQueueItemCompleted } from "./registry.js";
import { logger } from "../shared/logger.js";
import { WaitingRows, type WaitingRow } from "./queue-waiting-rows.js";

export class SessionQueue {
  private queues = new Map<string, Promise<void>>();
  /** Track which sessions are currently running */
  private running = new Set<string>();
  /** Track how many tasks exist per session key, including the active one. */
  private pending = new Map<string, number>();
  /** Track which session keys have been cancelled - queued tasks are skipped. */
  private cancelled = new Set<string>();
  /** Track which session keys are paused - queued tasks wait until resumed. */
  private paused = new Set<string>();
  /** Internal causal hold: a callback row owns the head, but waits for its
   * source session's completion backlog to reach a drain boundary. */
  private callbackDrainHeld = new Map<string, Set<string>>();
  /** Resolvers for tasks blocked on a paused session key, woken on resume. */
  private pauseWaiters = new Map<string, Array<() => void>>();
  /** Queue rows this process has already taken responsibility for. */
  private inFlightItems = new Set<string>();
  /** Per lane, the dispatches of rows that no slot has claimed yet. */
  private waitingRows = new WaitingRows((row) => this.inFlightItems.delete(row.id));
  /** Tasks waiting per key that have no durable row (connector turns, the talk
   * handoff). The row count alone cannot see them; they leave when they start. */
  private rowlessWaiting = new Map<string, number>();

  /**
   * Check if a session is currently running.
   */
  isRunning(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  /**
   * Has this process already accepted `queueItemId` for execution? A row only
   * flips to `running` in the DB when its task actually starts, so one parked
   * behind a long turn still reads `pending` and is indistinguishable from an
   * orphan to a recovery sweep. This is what tells the two apart.
   */
  hasInFlightItem(queueItemId: string): boolean {
    return this.inFlightItems.has(queueItemId);
  }

  getPendingCount(sessionKey: string): number {
    const total = this.pending.get(sessionKey) || 0;
    return this.running.has(sessionKey) ? Math.max(0, total - 1) : total;
  }

  /** Row-less tasks parked behind the running one: what the durable rows miss. */
  getRowlessWaitingCount(sessionKey: string): number {
    return this.rowlessWaiting.get(sessionKey) || 0;
  }

  getTransportState(sessionKey: string, status?: "idle" | "running" | "error" | "waiting" | "interrupted"): "idle" | "queued" | "running" | "error" | "interrupted" {
    if (status === "error") return "error";
    if (status === "interrupted") return "interrupted";
    if (this.running.has(sessionKey)) return "running";
    if (this.getPendingCount(sessionKey) > 0) return "queued";
    return status === "running" ? "running" : "idle";
  }

  /**
   * Add a session key to the cancelled set and remove it from pending.
   * Any queued tasks for this key will be skipped when they next execute.
   */
  clearQueue(sessionKey: string): void {
    this.cancelled.add(sessionKey);
    this.pending.delete(sessionKey);
    this.rowlessWaiting.delete(sessionKey);
    this.callbackDrainHeld.delete(sessionKey);
    this.wakePauseWaiters(sessionKey);
  }

  /**
   * Remove a session key from the cancelled set.
   * Call this before dispatching a new message so subsequent tasks run normally.
   */
  clearCancelled(sessionKey: string): void {
    this.cancelled.delete(sessionKey);
  }

  pauseQueue(sessionKey: string): void {
    this.paused.add(sessionKey);
  }

  resumeQueue(sessionKey: string): void {
    this.paused.delete(sessionKey);
    this.wakePauseWaiters(sessionKey);
  }

  private wakePauseWaiters(sessionKey: string): void {
    const waiters = this.pauseWaiters.get(sessionKey);
    if (!waiters) return;
    this.pauseWaiters.delete(sessionKey);
    for (const wake of waiters) wake();
  }

  isPaused(sessionKey: string): boolean {
    return this.paused.has(sessionKey);
  }

  holdForCallbackDrain(sessionKey: string, queueItemId: string): void {
    const held = this.callbackDrainHeld.get(sessionKey) ?? new Set<string>();
    held.add(queueItemId);
    this.callbackDrainHeld.set(sessionKey, held);
  }

  releaseCallbackDrain(sessionKey: string, queueItemId: string): void {
    const held = this.callbackDrainHeld.get(sessionKey);
    held?.delete(queueItemId);
    if (held?.size === 0) this.callbackDrainHeld.delete(sessionKey);
    this.wakePauseWaiters(sessionKey);
  }

  isCallbackDrainHeld(sessionKey: string, queueItemId?: string): boolean {
    const held = this.callbackDrainHeld.get(sessionKey);
    return queueItemId ? held?.has(queueItemId) === true : Boolean(held?.size);
  }

  /** Park until a resume, a released callback hold or a cleared lane wakes the waiters. */
  private parkUntilWoken(sessionKey: string): Promise<void> {
    return new Promise<void>(resolve => {
      const waiters = this.pauseWaiters.get(sessionKey) ?? [];
      waiters.push(resolve);
      this.pauseWaiters.set(sessionKey, waiters);
    });
  }

  private async waitWhilePaused(sessionKey: string): Promise<void> {
    while (this.paused.has(sessionKey)) await this.parkUntilWoken(sessionKey);
  }

  /**
   * Enqueue a task for a session. Tasks are serialized per session key.
   *
   * A task with a queue row does not run in the slot it was enqueued into. Each
   * slot, when its turn comes, claims the next pending row of the lane by
   * position and runs that row's own function, so the order of the rows can
   * change while they wait (a promoted message) without a row ever running
   * another row's dispatch. The returned promise settles with that function's
   * outcome, whichever slot ran it.
   */
  async enqueue(sessionKey: string, fn: () => Promise<void>, queueItemId?: string, claimed = false): Promise<void> {
    if (queueItemId) this.inFlightItems.add(queueItemId);
    const ahead = this.pending.get(sessionKey) || 0;
    this.pending.set(sessionKey, ahead + 1);
    // Say so when the turn will not start now. Without this the log goes quiet
    // between a route's "dispatching" and the engine's own spawn line, and a
    // lane busy for minutes reads as a dispatch that silently never happened.
    if (ahead > 0 && queueItemId) {
      const owner = getQueueItem(queueItemId)?.sessionId ?? "?";
      logger.info(`Session ${owner} turn ${queueItemId} queued behind ${ahead} turn(s) on lane ${sessionKey}`);
    }
    if (queueItemId && !claimed) return this.enqueueRow(sessionKey, fn, queueItemId);
    return this.enqueueOwn(sessionKey, fn, queueItemId);
  }

  /** A task that runs in its own slot: one with no durable row, or whose row was claimed by its enqueuer. */
  private enqueueOwn(sessionKey: string, fn: () => Promise<void>, queueItemId?: string): Promise<void> {
    if (!queueItemId) this.rowlessWaiting.set(sessionKey, this.getRowlessWaitingCount(sessionKey) + 1);
    const runTask = async () => {
      if (!queueItemId) this.leaveRowlessWaiting(sessionKey);
      this.running.add(sessionKey);
      let queueItemStarted = false;
      try {
        // Wait while paused — blocks until resumeQueue() wakes us (no polling)
        await this.waitWhilePaused(sessionKey);
        if (queueItemId) {
          if (!this.takeClaimedRow(sessionKey, queueItemId)) return;
          queueItemStarted = true;
        }
        if (!this.cancelled.has(sessionKey)) {
          await fn();
        }
      } finally {
        if (queueItemId) {
          if (queueItemStarted) markQueueItemCompleted(queueItemId);
          this.inFlightItems.delete(queueItemId);
        }
        this.running.delete(sessionKey);
        this.decrementPending(sessionKey);
      }
    };
    return this.chain(sessionKey, runTask);
  }

  private chain(sessionKey: string, runTask: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const next = prev.then(runTask, runTask);
    this.queues.set(sessionKey, next);
    void next.finally(() => {
      if (this.queues.get(sessionKey) === next) {
        this.queues.delete(sessionKey);
      }
    });
    return next;
  }

  private enqueueRow(sessionKey: string, fn: () => Promise<void>, queueItemId: string): Promise<void> {
    const settled = new Promise<void>((resolve, reject) => {
      this.waitingRows.add(sessionKey, { id: queueItemId, fn, resolve, reject });
    });
    const runSlot = async () => {
      this.running.add(sessionKey);
      let row: WaitingRow | undefined;
      let failure: { error: unknown } | undefined;
      try {
        row = await this.claimNextRow(sessionKey);
        if (row && !this.cancelled.has(sessionKey)) {
          try {
            await row.fn();
          } catch (error) {
            failure = { error };
          }
        }
      } finally {
        // Mark the DB row done in finally so an errored/cancelled task can't
        // leave the item stuck as 'running' (getQueueItems returns 'running'
        // rows, so a stuck row would keep the UI badge from draining).
        if (row) {
          markQueueItemCompleted(row.id);
          this.inFlightItems.delete(row.id);
        }
        this.running.delete(sessionKey);
        this.decrementPending(sessionKey);
        this.waitingRows.forgetIfEmpty(sessionKey);
      }
      if (row) failure ? row.reject(failure.error) : row.resolve();
    };
    void this.chain(sessionKey, runSlot);
    return settled;
  }

  /**
   * Claim the lane's next row: the pending one with the lowest position, once
   * the lane is neither paused nor holding that row for a callback drain.
   * Position is read here, as the slot starts, which is what lets a row be
   * promoted while it waits. Undefined when no row is left to run.
   */
  private async claimNextRow(sessionKey: string): Promise<WaitingRow | undefined> {
    for (;;) {
      if (this.paused.has(sessionKey)) {
        await this.parkUntilWoken(sessionKey);
        continue;
      }
      const head = this.waitingRows.next(sessionKey);
      if (!head) return undefined;
      if (this.isCallbackDrainHeld(sessionKey, head.id)) {
        await this.parkUntilWoken(sessionKey);
        continue;
      }
      this.waitingRows.take(sessionKey, head);
      if (markQueueItemRunning(head.id)) return head;
      this.waitingRows.skip(sessionKey, head, "no longer pending");
    }
  }

  /** A claimed row was flipped to running by its enqueuer; it runs only if it still is. */
  private takeClaimedRow(sessionKey: string, queueItemId: string): boolean {
    const item = getQueueItem(queueItemId);
    const runnable = item?.status === "running";
    if (!runnable) logger.warn(`Turn ${queueItemId} on lane ${sessionKey} skipped: queue row is ${item ? item.status : "gone"}`);
    return runnable;
  }

  private leaveRowlessWaiting(sessionKey: string): void {
    const remaining = this.getRowlessWaitingCount(sessionKey) - 1;
    if (remaining > 0) this.rowlessWaiting.set(sessionKey, remaining);
    else this.rowlessWaiting.delete(sessionKey);
  }

  private decrementPending(sessionKey: string): void {
    const remaining = (this.pending.get(sessionKey) || 1) - 1;
    if (remaining <= 0) {
      this.pending.delete(sessionKey);
      return;
    }
    this.pending.set(sessionKey, remaining);
  }
}
