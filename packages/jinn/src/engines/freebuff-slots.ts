/**
 * Freebuff bills hours, and every concurrent process spends them: a second
 * instance opens a second hour session and is charged again, where a process
 * started later with `--continue` re-joins the session already running.
 *
 * So the number of Freebuff processes alive at once is a budget, and this is the
 * gate on it. It is account-wide because the account is: one count covers the
 * gateway's own processes and every remote host's.
 *
 * A slot belongs to a Marid session for as long as its process lives. A process
 * waiting for its next turn is `idle`, and an idle slot can be taken over: its
 * process is killed and its chat is resumed later, inside the same hour session
 * at no charge. A slot serving a turn is `busy` and is never taken. Turns that
 * find every slot busy queue, first in first out; they do not fail.
 */

export type SlotState = "busy" | "idle";

export interface FreebuffSlotsOpts {
  /** The cap, read on every decision so a hot-reloaded config applies at once. */
  max: () => number;
  /** Stop the process holding an idle slot so its slot can be given away. */
  evict: (sessionId: string) => void;
  now?: () => number;
}

interface Slot {
  state: SlotState;
  since: number;
}

interface Waiter {
  sessionId: string;
  grant: () => void;
  fail: (err: Error) => void;
}

export class FreebuffSlots {
  private readonly slots = new Map<string, Slot>();
  private readonly queue: Waiter[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: FreebuffSlotsOpts) {
    this.now = opts.now ?? Date.now;
  }

  /** Slots in use, idle ones included. */
  get used(): number {
    return this.slots.size;
  }

  /** Turns waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  holds(sessionId: string): boolean {
    return this.slots.has(sessionId);
  }

  stateOf(sessionId: string): SlotState | undefined {
    return this.slots.get(sessionId)?.state;
  }

  private cap(): number {
    const max = this.opts.max();
    return Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 1;
  }

  /** The idle slot that has waited longest, or undefined if every slot is busy. */
  private oldestIdle(): string | undefined {
    let pick: [string, number] | undefined;
    for (const [id, slot] of this.slots) {
      if (slot.state === "idle" && (!pick || slot.since < pick[1])) pick = [id, slot.since];
    }
    return pick?.[0];
  }

  /** Take a slot for `sessionId` now if one is free or can be taken over. */
  private tryTake(sessionId: string): boolean {
    const held = this.slots.get(sessionId);
    if (held) {
      held.state = "busy";
      held.since = this.now();
      return true;
    }
    while (this.slots.size >= this.cap()) {
      const victim = this.oldestIdle();
      if (!victim) return false;
      this.slots.delete(victim);
      this.opts.evict(victim);
    }
    this.slots.set(sessionId, { state: "busy", since: this.now() });
    return true;
  }

  /**
   * A slot for `sessionId`'s turn: immediately if it already holds one, or one
   * is free, or an idle one can be taken over; otherwise when one is. Rejects if
   * `signal` aborts first, having left the queue.
   */
  acquire(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.queue.length === 0 && this.tryTake(sessionId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        sessionId,
        grant: () => { signal?.removeEventListener("abort", onAbort); resolve(); },
        fail: reject,
      };
      const onAbort = () => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /** The turn is over; the process stays up, and its slot may now be taken over. */
  markIdle(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.state = "idle";
    slot.since = this.now();
    this.drain();
  }

  /**
   * A slot for a process with no turn behind it (the dashboard's terminal), only
   * if one is free or idle: a view never queues, and never displaces a turn.
   * Held as idle, so a turn can take it over.
   */
  tryAcquireIdle(sessionId: string): boolean {
    if (this.slots.has(sessionId)) return true;
    if (this.queue.length > 0) return false;
    if (!this.tryTake(sessionId)) return false;
    this.slots.get(sessionId)!.state = "idle";
    return true;
  }

  /** The process is gone (it exited, or was released): free its slot. */
  release(sessionId: string): void {
    if (!this.slots.delete(sessionId)) return;
    this.drain();
  }

  /** Give slots to waiting turns in arrival order, for as long as any can be had. */
  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!this.tryTake(next.sessionId)) return;
      this.queue.shift();
      next.grant();
    }
  }

  /** Fail every queued turn (the engine is shutting down). */
  rejectAll(err: Error): void {
    for (const waiter of this.queue.splice(0)) waiter.fail(err);
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "aborted while waiting for a Freebuff slot");
}
