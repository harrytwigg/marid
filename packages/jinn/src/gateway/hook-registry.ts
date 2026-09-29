export interface HookPayload {
  hook_event_name: "SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse" | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  tool_name?: string;
  /** Present on StopFailure: enum — rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown */
  error?: string;
  error_details?: string;
  [k: string]: unknown;
}

type HookListener = (h: HookPayload) => void;
type UnclaimedHookHandler = (jinnSessionId: string, h: HookPayload, context?: { foreignToRunningTurn?: boolean }) => void;
interface Buffered { payload: HookPayload; at: number; }

export class HookRegistry {
  private listeners = new Map<string, HookListener>();
  private buffer = new Map<string, Buffered[]>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Fallback consumer for Stop hooks no turn ever claims (PTY-native turns
   *  typed straight into the xterm view, or a Stop arriving past the late-
   *  recovery window). Set once by the gateway. */
  private unclaimedHandler: UnclaimedHookHandler | undefined;
  /** Observers of every delivery, claimed or not (see tap()). */
  private taps = new Set<(jinnSessionId: string, h: HookPayload) => void>();
  /** Per-session debounce timers for the unclaimed-Stop fallback. */
  private unclaimedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private ttlMs = 30_000, sweepIntervalMs = 5_000, private unclaimedDelayMs = 2_000) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't keep the event loop alive for the sweep timer.
    this.sweepTimer.unref?.();
  }

  /** Install the fallback consumer for unclaimed Stop hooks. A Stop that lands
   *  with no registered listener is buffered as usual AND starts/refreshes a
   *  short timer; if the session is still unclaimed when it fires, the handler
   *  receives the Stop (and the consumed Stops leave the buffer so a later
   *  register() can't replay them into a NEW turn's resolver). */
  setUnclaimedHookHandler(handler: UnclaimedHookHandler): void {
    this.unclaimedHandler = handler;
  }

  register(jinnSessionId: string, listener: HookListener): void {
    if (this.listeners.has(jinnSessionId)) {
      // Engine guards against concurrent turns per session, so this should
      // never happen. Warn loudly if it does — silently overwriting the
      // previous listener would mean the prior turn's resolver never fires.
      console.warn(
        `[HookRegistry] duplicate listener registration for session ${jinnSessionId}; previous listener will be replaced`,
      );
    }
    this.listeners.set(jinnSessionId, listener);
    // A turn claimed the session — the buffered events are its, not the
    // unclaimed-fallback's.
    this.cancelUnclaimedTimer(jinnSessionId);
    const pending = this.buffer.get(jinnSessionId);
    if (pending) {
      this.buffer.delete(jinnSessionId);
      const now = Date.now();
      for (const b of pending) {
        if (now - b.at <= this.ttlMs) listener(b.payload);
      }
    }
  }

  unregister(jinnSessionId: string): void {
    this.listeners.delete(jinnSessionId);
    this.buffer.delete(jinnSessionId);
  }

  /** See every hook as it arrives, before it is routed to a listener or the
   *  buffer. The claude engine uses it to notice a turn typed into the terminal
   * or a background re-invocation while no gateway turn
   *  owns the session. Returns an unsubscribe. */
  tap(observer: (jinnSessionId: string, h: HookPayload) => void): () => void {
    this.taps.add(observer);
    return () => { this.taps.delete(observer); };
  }

  deliver(jinnSessionId: string, payload: HookPayload): void {
    for (const observer of this.taps) {
      try { observer(jinnSessionId, payload); } catch (err) {
        console.warn(`[HookRegistry] hook tap threw for ${jinnSessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const listener = this.listeners.get(jinnSessionId);
    if (listener) { listener(payload); return; }
    const arr = this.buffer.get(jinnSessionId) ?? [];
    arr.push({ payload, at: Date.now() });
    this.buffer.set(jinnSessionId, arr);
    // Unclaimed Stop with real output → arm/refresh the fallback timer. The
    // delay protects the registration race at turn start: an in-flight run()
    // registers its listener BEFORE the prompt is even written to the PTY
    // (claude-interactive.ts run(): register → inject/spawn), so a Stop
    // belonging to a gateway-run turn can never sit unclaimed for long — by the
    // time the timer fires, "still unclaimed" means no run() owns this session
    // (a PTY-native turn) or the Stop arrived past the late-recovery window.
    if (
      this.unclaimedHandler &&
      payload.hook_event_name === "Stop" &&
      String(payload.last_assistant_message ?? "").trim()
    ) {
      this.armUnclaimedTimer(jinnSessionId);
    }
  }

  /** Hand a Stop straight to the unclaimed-Stop consumer even though a listener
   *  is registered. Used when the registered turn has recognised the Stop as
   *  not its own — a turn typed into the terminal or a background
   *  re-invocation that finished while the gateway's prompt sat
   *  queued behind it, or one replayed from the buffer that finished before the
   *  turn registered. Synchronous on purpose: Claude Code is still blocked on
   *  this Stop hook, so the transcript tail cannot yet contain the queued
   *  prompt that runs next. */
  consumeAsUnclaimed(jinnSessionId: string, payload: HookPayload): void {
    if (!this.unclaimedHandler) return;
    if (payload.hook_event_name !== "Stop" || !String(payload.last_assistant_message ?? "").trim()) return;
    try {
      this.unclaimedHandler(jinnSessionId, payload, { foreignToRunningTurn: true });
    } catch (err) {
      console.warn(`[HookRegistry] unclaimed hook handler threw for ${jinnSessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private armUnclaimedTimer(jinnSessionId: string): void {
    this.cancelUnclaimedTimer(jinnSessionId);
    const timer = setTimeout(() => this.fireUnclaimed(jinnSessionId), this.unclaimedDelayMs);
    timer.unref?.();
    this.unclaimedTimers.set(jinnSessionId, timer);
  }

  private cancelUnclaimedTimer(jinnSessionId: string): void {
    const t = this.unclaimedTimers.get(jinnSessionId);
    if (t) {
      clearTimeout(t);
      this.unclaimedTimers.delete(jinnSessionId);
    }
  }

  /** Timer expired with the session still unclaimed: hand the buffered Stop(s)
   *  to the fallback handler. Consumed Stops are REMOVED from the buffer so a
   *  later register() can't drain a stale Stop into a fresh turn's resolver.
   *  Only the newest Stop is delivered — the handler syncs the transcript tail
   *  from an anchor, so intermediate Stops are covered by the same sync. */
  private fireUnclaimed(jinnSessionId: string): void {
    this.unclaimedTimers.delete(jinnSessionId);
    if (!this.unclaimedHandler) return;
    if (this.listeners.has(jinnSessionId)) return; // claimed in the meantime
    const arr = this.buffer.get(jinnSessionId);
    if (!arr || arr.length === 0) return;
    const isConsumable = (b: Buffered) =>
      b.payload.hook_event_name === "Stop" && String(b.payload.last_assistant_message ?? "").trim() !== "";
    const stops = arr.filter(isConsumable);
    if (stops.length === 0) return;
    const rest = arr.filter((b) => !isConsumable(b));
    if (rest.length === 0) this.buffer.delete(jinnSessionId);
    else this.buffer.set(jinnSessionId, rest);
    try {
      this.unclaimedHandler(jinnSessionId, stops[stops.length - 1].payload);
    } catch (err) {
      console.warn(`[HookRegistry] unclaimed hook handler threw for ${jinnSessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Drop buffered entries whose `at` is older than ttlMs. */
  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [sid, arr] of this.buffer) {
      const fresh = arr.filter((b) => b.at >= cutoff);
      if (fresh.length === 0) this.buffer.delete(sid);
      else if (fresh.length !== arr.length) this.buffer.set(sid, fresh);
    }
  }

  /** Stop the periodic sweep timer. Call when shutting down the registry. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const t of this.unclaimedTimers.values()) clearTimeout(t);
    this.unclaimedTimers.clear();
  }
}
