import type { EngineRateLimitInfo } from "../shared/types.js";
import { dumpScreen } from "./freebuff-terminal.js";
import type { FreebuffScreenInfo } from "./freebuff-screen.js";

/** How long a screen nothing here recognises may stand before the turn gives up on it. */
export const UNKNOWN_SCREEN_LIMIT_MS = 60_000;

/**
 * A turn that cannot go on, in the shape the turn runner already understands.
 * `rateLimit` makes the configured `fallback` engines take over; the rest is an
 * ordinary engine error. None of these means the conversation is gone, so the
 * result says it is intact and the session keeps its chat id.
 */
export class FreebuffFailure extends Error {
  constructor(message: string, readonly rateLimit?: EngineRateLimitInfo) {
    super(message);
    this.name = "FreebuffFailure";
  }
}

export type FreebuffPlace = "local" | "remote";

/**
 * A refusal printed in the chat, as the failure it is. Used while a message is
 * going in, never while the model is answering: an answer can quote any of these.
 * `released` is not a failure at all (the caller starts the process afresh) and is
 * left to it.
 */
export function refusalFailure(refusal: NonNullable<FreebuffScreenInfo["refusal"]>): FreebuffFailure | undefined {
  switch (refusal.kind) {
    case "no-hours":
      return new FreebuffFailure(`Freebuff would not start a session: ${refusal.text}`, { status: "rejected", rateLimitType: "hours" });
    case "session-limit":
    case "network-cap":
      return new FreebuffFailure(`Freebuff would not start a session: ${refusal.text}`, { status: "rejected", rateLimitType: "sessions" });
    case "concurrent-limit":
      return new FreebuffFailure(`Freebuff will not start a session while another one holds the account's slot; only a person at the terminal can take it over. Freebuff said: ${refusal.text}`);
    case "unavailable":
      return new FreebuffFailure(`Freebuff cannot run here: ${refusal.text}`);
    case "released":
      return undefined;
  }
}

export function notSignedInMessage(place: FreebuffPlace): string {
  return `freebuff is not signed in on ${place}; run "freebuff login" there`;
}

/** Freebuff's allowance is hours; none left is a quota, so a fallback engine may take the turn. */
export function noHoursFailure(info: Pick<FreebuffScreenInfo, "hoursRemaining" | "hoursTotal">): FreebuffFailure {
  const balance = info.hoursTotal !== undefined ? ` (0/${info.hoursTotal} hours remaining)` : "";
  return new FreebuffFailure(`Freebuff has no hours left today${balance}; the allowance resets daily`, { status: "rejected", rateLimitType: "hours" });
}

/**
 * What the screen already says is wrong, before or during a turn.
 *
 * Signed out is never "fixed" by pressing Enter on the sign-in screen: that
 * starts a browser login nobody is there to finish. No hours left only counts
 * before a session is running, because a running session keeps going on hours
 * it has already been charged.
 */
export function screenFailure(info: FreebuffScreenInfo, place: FreebuffPlace): FreebuffFailure | undefined {
  if (info.state === "signed-out") return new FreebuffFailure(notSignedInMessage(place));
  if (info.hoursRemaining === 0 && !info.sessionActive) return noHoursFailure(info);
  return undefined;
}

/** A screen the parser has no name for, carried into the error so the next fix has the evidence. */
export function unknownScreenFailure(lines: readonly string[], seconds: number): FreebuffFailure {
  return new FreebuffFailure(`Freebuff showed a screen Marid does not recognise for ${seconds}s:\n${dumpScreen(lines)}`);
}

/** Freebuff dropped its hour session before the message went in: start the process afresh and try once more. */
export class SessionReleased extends Error {
  constructor(text: string) {
    super(text);
    this.name = "SessionReleased";
  }
}
