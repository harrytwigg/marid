import { FreebuffFailure, UNKNOWN_SCREEN_LIMIT_MS, refusalFailure, screenFailure, unknownScreenFailure, type FreebuffPlace } from "./freebuff-failure.js";
import type { FreebuffScreenInfo } from "./freebuff-screen.js";

/** Idle after busy, with the `⎘ • 11s` footer up, for this long: the turn is over. */
export const SETTLE_MS = 1_500;
/** Idle after busy but no footer: wait this long for one before taking the turn as over anyway. */
export const FOOTER_GRACE_MS = 15_000;
/** The message was pasted and submitted, yet the screen never went busy. */
export const NOT_ACCEPTED_MS = 30_000;

/** Fails the turn when a screen nothing recognises has stood for {@link UNKNOWN_SCREEN_LIMIT_MS}. */
export class UnknownScreenWatch {
  private since: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  check(info: FreebuffScreenInfo, lines: readonly string[]): void {
    if (info.state !== "unknown") {
      this.since = undefined;
      return;
    }
    this.since ??= this.now();
    if (this.now() - this.since >= UNKNOWN_SCREEN_LIMIT_MS) throw unknownScreenFailure(lines, Math.round(UNKNOWN_SCREEN_LIMIT_MS / 1000));
  }
}

/** What the watch makes of one more look at the screen. */
export type WatchVerdict = "wait" | "done" | "stalled";

/**
 * Decides when a turn is over, from the screens seen after the message went in:
 * busy, then idle again with the footer up and held for a moment. The footer of an
 * earlier turn can still be on screen, so nothing counts until this turn has been
 * seen busy. Throws the failure when the screen says the turn cannot go on.
 *
 * `stalled` is an idle input that never went busy: either the turn was so short it
 * came and went between looks, or the message was not taken. Only the chat can say
 * which, so the caller asks it.
 */
export class FinishWatch {
  private sawBusy = false;
  private idleSince: number | undefined;
  private readonly unknown: UnknownScreenWatch;

  constructor(
    private readonly place: FreebuffPlace,
    private readonly submittedAt: number,
    private readonly now: () => number = Date.now,
  ) {
    this.unknown = new UnknownScreenWatch(now);
  }

  observe(info: FreebuffScreenInfo, lines: readonly string[]): WatchVerdict {
    this.guard(info, lines);
    if (info.state === "busy") {
      this.sawBusy = true;
      this.idleSince = undefined;
      return "wait";
    }
    if (info.state !== "idle") return "wait";
    return this.sawBusy ? this.settled(info) : this.accepted();
  }

  private guard(info: FreebuffScreenInfo, lines: readonly string[]): void {
    const failure = screenFailure(info, this.place);
    if (failure) throw failure;
    // Only before the model starts answering: once it has, its words are its own.
    if (!this.sawBusy && info.refusal) throw refusalFailure(info.refusal) ?? droppedSession(info.refusal.text);
    this.unknown.check(info, lines);
  }

  private settled(info: FreebuffScreenInfo): WatchVerdict {
    this.idleSince ??= this.now();
    const idleFor = this.now() - this.idleSince;
    if (info.turnFooter && idleFor >= SETTLE_MS) return "done";
    return idleFor >= FOOTER_GRACE_MS ? "done" : "wait";
  }

  private accepted(): WatchVerdict {
    return this.now() - this.submittedAt >= NOT_ACCEPTED_MS ? "stalled" : "wait";
  }
}

function droppedSession(text: string): FreebuffFailure {
  return new FreebuffFailure(`Freebuff dropped its session as the message went in (${text}); the next turn starts the process afresh and re-joins the chat`);
}
