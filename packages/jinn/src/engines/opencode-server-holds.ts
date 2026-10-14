/** Who holds a server: a turn, which needs it to stay as it is, or a
 *  terminal view, which follows whatever server the session has. */
export type HoldKind = "turn" | "view";

/**
 * The holds on each session's opencode server, by kind, and the turns waiting
 * for a session's turn holds to drop. A view's release never takes a turn's
 * hold: a view that outlives a server replacement releases late, onto the
 * successor a turn holds.
 */
export class ServerHolds {
  private counts = new Map<string, Record<HoldKind, number>>();
  private turnWaiters = new Map<string, Array<() => void>>();

  take(sessionId: string, kind: HoldKind): void {
    const counts = this.counts.get(sessionId) ?? { turn: 0, view: 0 };
    counts[kind] += 1;
    this.counts.set(sessionId, counts);
  }

  /** Drop one hold of `kind`; false when there was none. Waiters wake once
   *  the session's last turn hold is gone. */
  drop(sessionId: string, kind: HoldKind): boolean {
    const counts = this.counts.get(sessionId);
    if (!counts?.[kind]) return false;
    counts[kind] -= 1;
    if (kind === "turn" && !counts.turn) this.wake(sessionId);
    if (!counts.turn && !counts.view) this.counts.delete(sessionId);
    return true;
  }

  /** The server went: every hold on it went with it. */
  clear(sessionId: string): void {
    this.counts.delete(sessionId);
    this.wake(sessionId);
  }

  count(sessionId: string, kind?: HoldKind): number {
    const counts = this.counts.get(sessionId);
    if (!counts) return 0;
    return kind ? counts[kind] : counts.turn + counts.view;
  }

  /** Resolves once no turn holds the session's server, or it has none. */
  turnHoldsDropped(sessionId: string): Promise<void> {
    if (!this.count(sessionId, "turn")) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.turnWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.turnWaiters.set(sessionId, waiters);
    });
  }

  private wake(sessionId: string): void {
    const waiters = this.turnWaiters.get(sessionId);
    this.turnWaiters.delete(sessionId);
    for (const wake of waiters ?? []) wake();
  }
}
