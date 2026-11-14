/**
 * Noticing that a usage limit lifted before the reset it stated.
 *
 * A wait sleeps to the reset the engine named when the limit hit. A limit can
 * end before that: the provider resets it early, the operator takes an offered
 * reset, or the window's reset time moves. The gateway already reads every
 * Claude account's usage on a schedule (background-refresh.ts) and keeps the
 * readings per account (claude-usage-history.ts), so the wait looks at the
 * newest one now and then, and wakes early when it says the limit is gone or
 * reopens sooner.
 *
 * Only a reading taken AFTER the latest limited answer counts: an older one
 * predates the limit and says nothing about it. That also bounds a reading that
 * is wrong (a limit the usage readout does not show): the retry it causes comes
 * back limited, which moves the bar past that reading, so it can cost at most
 * one probe per new reading. A reset that moved LATER is left alone: the retry
 * at the old time costs one probe and learns the new time from the engine.
 */
import { latestAccountReading } from "../shared/fallback-chain-limits.js";
import type { UsageSample } from "../shared/claude-usage-history.js";

/** How often a sleeping wait looks at the account's newest reading. Readings
 *  land every quarter hour, so a minute is ample and costs one stat. */
export const EARLY_RESET_POLL_MS = 60_000;
/** A reopening must come this much sooner than the wait's own target to move it. */
const MOVED_EARLIER_MARGIN_MS = 60_000;
/** Retry this long after a reopening, as the stated-reset sleep does. */
const REOPEN_BUFFER_MS = 10_000;

export type EarlyReset =
  /** A reading shows no window spent: the limit has lifted. */
  | { kind: "lifted"; readAt: Date }
  /** The spent window now reopens sooner than the wait's target. */
  | { kind: "moved"; readAt: Date; reopensAt: Date };

/** What one reading says about a limit last seen at `limitedAtMs`, against the wait's current target. Pure. */
export function earlyResetFrom(
  sample: UsageSample | undefined,
  limitedAtMs: number,
  targetMs: number | undefined,
  nowMs: number,
): EarlyReset | undefined {
  if (!sample || sample.at <= limitedAtMs) return undefined;
  const readAt = new Date(sample.at);
  const spent = sample.windows.filter((window) => window.usedPercent >= 100 && window.resetsAt * 1000 > nowMs);
  if (spent.length === 0) return { kind: "lifted", readAt };
  const reopensMs = Math.max(...spent.map((window) => window.resetsAt * 1000));
  if (targetMs !== undefined && reopensMs < targetMs - MOVED_EARLIER_MARGIN_MS) return { kind: "moved", readAt, reopensAt: new Date(reopensMs) };
  return undefined;
}

export interface EarlyResetWatch {
  /** When the sleep should end instead, if the newest reading moves it: now, or a sooner reopening. */
  wakeAt(targetMs: number | undefined): { atMs: number; reset: EarlyReset } | undefined;
  /** The engine answered limited again: only readings after this count. */
  limitedAgain(): void;
}

/**
 * A watch over one account's readings, for engines the gateway reads usage for
 * (Claude). Others get none, and their waits sleep to the stated reset as before.
 */
export function earlyResetWatch(
  engine: string,
  account: string,
  now: () => number = Date.now,
  read: (account: string) => UsageSample | undefined = latestAccountReading,
): EarlyResetWatch | undefined {
  if (engine !== "claude") return undefined;
  let limitedAtMs = now();
  let reported = 0;
  return {
    wakeAt(targetMs) {
      const reset = earlyResetFrom(read(account), limitedAtMs, targetMs, now());
      if (!reset || reset.readAt.getTime() === reported) return undefined;
      reported = reset.readAt.getTime();
      return { atMs: reset.kind === "lifted" ? now() : reset.reopensAt.getTime() + REOPEN_BUFFER_MS, reset };
    },
    limitedAgain() {
      limitedAtMs = now();
    },
  };
}
