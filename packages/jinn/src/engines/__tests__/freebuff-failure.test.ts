import { describe, expect, it } from "vitest";
import { detectRateLimit } from "../../shared/rateLimit.js";
import { FreebuffFailure, noHoursFailure, notSignedInMessage, refusalFailure, screenFailure, unknownScreenFailure } from "../freebuff-failure.js";
import { parseFreebuffScreen } from "../freebuff-screen.js";
import { screen } from "./helpers/freebuff-fixtures.js";

describe("screenFailure", () => {
  it("maps both sign-in screens to the not-signed-in error, per place", () => {
    for (const name of ["signed-out.txt", "signed-out-enter.txt"]) {
      const failure = screenFailure(parseFreebuffScreen(screen(name)), "remote");
      expect(failure?.message).toBe('freebuff is not signed in on remote; run "freebuff login" there');
      expect(failure?.rateLimit).toBeUndefined();
    }
    expect(notSignedInMessage("local")).toBe('freebuff is not signed in on local; run "freebuff login" there');
  });

  it("maps no hours left before a session to a rate limit the fallback chain acts on", () => {
    const lines = screen("idle-before-session.txt").map((l) => l.replace("21/21 hours remaining", "0/21 hours remaining"));
    const failure = screenFailure(parseFreebuffScreen(lines), "local");
    expect(failure).toBeInstanceOf(FreebuffFailure);
    expect(failure?.message).toContain("0/21 hours remaining");
    expect(failure?.rateLimit).toEqual({ status: "rejected", rateLimitType: "hours" });
    // The turn runner reads it as a limit, not a fault.
    expect(detectRateLimit({ sessionId: "", result: "", error: failure!.message, rateLimit: failure!.rateLimit }).limited).toBe(true);
  });

  it("lets a running session carry on with the hours it was already charged", () => {
    const lines = screen("idle-session-active.txt").map((l) => l.replace("17/21 hours remaining", "0/21 hours remaining"));
    expect(screenFailure(parseFreebuffScreen(lines), "local")).toBeUndefined();
  });

  it("has nothing to say about an ordinary idle or busy screen", () => {
    expect(screenFailure(parseFreebuffScreen(screen("idle-before-session.txt")), "local")).toBeUndefined();
    expect(screenFailure(parseFreebuffScreen(screen("busy.txt")), "local")).toBeUndefined();
  });
});

describe("refusalFailure", () => {
  it("makes a quota of an hours or sessions limit, so a fallback engine takes the turn", () => {
    const hours = refusalFailure({ kind: "no-hours", text: "Not enough hours: 0.4 available." });
    expect(hours?.rateLimit).toEqual({ status: "rejected", rateLimitType: "hours" });
    expect(hours?.message).toBe("Freebuff would not start a session: Not enough hours: 0.4 available.");
    expect(refusalFailure({ kind: "session-limit", text: "Session limit reached." })?.rateLimit?.rateLimitType).toBe("sessions");
    expect(refusalFailure({ kind: "network-cap", text: "Too many Freebuff sessions on this network." })?.rateLimit?.status).toBe("rejected");
  });

  it("fails plainly, with no fallback, when only a person could take the slot over", () => {
    const failure = refusalFailure({ kind: "concurrent-limit", text: "Your concurrent-session limit across CLI and Desktop is reached." });
    expect(failure?.rateLimit).toBeUndefined();
    expect(failure?.message).toContain("only a person at the terminal can take it over");
  });

  it("leaves a released session to the caller, which starts the process afresh", () => {
    expect(refusalFailure({ kind: "released", text: "This session was released." })).toBeUndefined();
  });
});

describe("noHoursFailure", () => {
  it("omits the balance it does not have", () => {
    expect(noHoursFailure({ hoursRemaining: 0 }).message).toBe("Freebuff has no hours left today; the allowance resets daily");
  });
});

describe("unknownScreenFailure", () => {
  it("carries the screen, without its blank tail", () => {
    const failure = unknownScreenFailure(["", "Some new modal", "  press a key", "", ""], 60);
    expect(failure.message).toBe("Freebuff showed a screen Marid does not recognise for 60s:\n\nSome new modal\n  press a key");
    expect(failure.rateLimit).toBeUndefined();
  });
});
