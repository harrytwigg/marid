import { describe, expect, it } from "vitest";
import { FinishWatch, FOOTER_GRACE_MS, NOT_ACCEPTED_MS, SETTLE_MS } from "../freebuff-turn-watch.js";
import { SessionReleased, UNKNOWN_SCREEN_LIMIT_MS } from "../freebuff-failure.js";
import { countRefusals, parseFreebuffScreen, type FreebuffRefusal } from "../freebuff-screen.js";

type RefusalKind = FreebuffRefusal["kind"];
import { screen } from "./helpers/freebuff-fixtures.js";

function watch(baseline = new Map<RefusalKind, number>()) {
  let t = 1_000_000;
  const w = new FinishWatch("local", t, baseline, () => t);
  const look = (lines: string[], advance = 0) => {
    t += advance;
    return w.observe(parseFreebuffScreen(lines), lines);
  };
  return { look, advance: (ms: number) => { t += ms; } };
}

describe("FinishWatch", () => {
  it("is done only after busy, then idle with the footer held for the settle time", () => {
    const { look } = watch();
    expect(look(screen("busy.txt"))).toBe("wait");
    expect(look(screen("turn-finished.txt"))).toBe("wait");
    expect(look(screen("turn-finished.txt"), SETTLE_MS - 1)).toBe("wait");
    expect(look(screen("turn-finished.txt"), 1)).toBe("done");
  });

  it("starts the settle again if the screen goes busy in between", () => {
    const { look } = watch();
    look(screen("busy.txt"));
    look(screen("turn-finished.txt"));
    look(screen("busy.txt"), SETTLE_MS);
    expect(look(screen("turn-finished.txt"), SETTLE_MS)).toBe("wait");
  });

  it("does not take the footer of an earlier turn for this one's", () => {
    const { look } = watch();
    expect(look(screen("turn-finished.txt"), SETTLE_MS * 2)).toBe("wait");
  });

  it("takes an idle screen with no footer as over after the grace, having been busy", () => {
    const { look } = watch();
    look(screen("busy.txt"));
    expect(look(screen("idle-session-active.txt"))).toBe("wait");
    expect(look(screen("idle-session-active.txt"), FOOTER_GRACE_MS)).toBe("done");
  });

  it("reports a screen that never went busy as stalled once the message should have been taken", () => {
    const { look } = watch();
    expect(look(screen("idle-session-active.txt"), NOT_ACCEPTED_MS - 1)).toBe("wait");
    expect(look(screen("idle-session-active.txt"), 1)).toBe("stalled");
  });

  it("fails on a refusal printed before the model started, and ignores the same words once it has", () => {
    const refused = ["", "  Session limit reached. See https://freebuff.com/plans or choose another model with /model.", ...screen("idle-session-active.txt")];
    expect(() => watch().look(refused)).toThrow(/would not start a session/);
    const { look } = watch();
    look(screen("busy.txt"));
    expect(look(refused)).toBe("wait");
  });

  it("ignores a refusal that was already on screen when the message went in, and takes a second one", () => {
    const old = ["  Session limit reached. See https://freebuff.com/plans or choose another model with /model.", ...screen("idle-session-active.txt")];
    const baseline = countRefusals(parseFreebuffScreen(old).refusals);
    const { look } = watch(baseline);
    expect(look(old)).toBe("wait");
    expect(() => look(["  Session limit reached. See https://freebuff.com/plans.", ...old])).toThrow(/would not start a session/);
  });

  it("asks to start again when the session was released as the message went in", () => {
    const released = ["", "  This session was released. Choose a model to start a new session.", ...screen("idle-session-active.txt")];
    expect(() => watch().look(released)).toThrow(SessionReleased);
  });

  it("fails on a sign-in screen at any point", () => {
    const { look } = watch();
    look(screen("busy.txt"));
    expect(() => look(screen("signed-out.txt"))).toThrow('freebuff is not signed in on local; run "freebuff login" there');
  });

  it("fails on a screen nothing recognises, with that screen in the error, after the limit and not before", () => {
    const { look } = watch();
    const odd = ["", "A modal nobody has seen", "  press a key"];
    expect(look(odd)).toBe("wait");
    expect(look(odd, UNKNOWN_SCREEN_LIMIT_MS - 1)).toBe("wait");
    expect(() => look(odd, 1)).toThrow(/does not recognise for 60s:\n\nA modal nobody has seen/);
  });

  it("forgets an unknown screen once a known one comes back", () => {
    const { look } = watch();
    const odd = ["", "A modal nobody has seen"];
    look(odd);
    look(screen("busy.txt"), UNKNOWN_SCREEN_LIMIT_MS - 1);
    expect(look(odd, 2)).toBe("wait");
  });
});
