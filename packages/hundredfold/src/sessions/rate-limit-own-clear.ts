/**
 * Ending a stand-in's usage-limit wait when the session's own target clears.
 *
 * A session that left its own target waits on the stand-in's limit with a
 * hand-back pending: it goes back to its own target at the override's `until`
 * at the latest. That can be days away, while the own target's health record may
 * already have been cleared (a usage reading showed headroom, a turn was served).
 * The wait looks for that clear on entry, once a minute while it sleeps, and
 * after each wake, and hands the turn back as soon as it finds one.
 */

import type { Employee, HundredfoldConfig, Session } from "../shared/types.js";
import { getSession } from "./registry.js";
import { ownTargetCleared } from "./engine-override.js";

/** Why a wait with a hand-back pending should hand back now: the override's window has closed, or the own target was cleared. */
export type HandBackDue = "window" | "own-target-cleared";

export interface OwnClearInput {
  session: Session;
  employee?: Employee;
  config?: HundredfoldConfig;
}

/** The own-target check for a wait, read off the live row: its override is the one the hand-back's revert acts on. Only consulted with a hand-back pending (`handBackDue`, `withOwnClearWake`). */
export function ownTargetClearedCheck(input: OwnClearInput): () => boolean {
  const { session, employee, config } = input;
  return () => ownTargetCleared(getSession(session.id) ?? session, employee, config);
}

/** Whether the wait should hand the turn back now, and why. */
export function handBackDue(handBackAt: Date | undefined, ownCleared: () => boolean, nowMs: number = Date.now()): HandBackDue | undefined {
  if (!handBackAt) return undefined;
  if (nowMs >= handBackAt.getTime()) return "window";
  return ownCleared() ? "own-target-cleared" : undefined;
}

/** The sleep's early wake that also ends it when the own target has cleared; the earliest of it and `watch` wins. */
export function withOwnClearWake(
  watch: ((endMs: number) => number | undefined) | undefined,
  ownCleared: () => boolean,
  handBackAt: Date | undefined,
  nowMs: () => number = Date.now,
): ((endMs: number) => number | undefined) | undefined {
  if (!handBackAt) return watch;
  return (endMs) => {
    const watched = watch?.(endMs);
    if (!ownCleared()) return watched;
    return watched === undefined ? nowMs() : Math.min(watched, nowMs());
  };
}
