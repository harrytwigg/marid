import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuseTurn } from "../musecode-turn.js";
import { watchForSilence } from "../musecode-watchdog.js";

const SID = "01a13fb8-5801-7983-8ae6-77432f86606b";

/** Whether the watch has fired once `ms` have passed. */
async function firedAfter(watch: { silent: Promise<void> }, ms: number): Promise<boolean> {
  let fired = false;
  void watch.silent.then(() => { fired = true; });
  await vi.advanceTimersByTimeAsync(ms);
  return fired;
}

describe("the first-event watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires when `turn/started` never comes", async () => {
    const turn = new MuseTurn(SID);
    expect(await firedAfter(watchForSilence(turn, 5000), 6000)).toBe(true);
  });

  it("is not satisfied by anything but `turn/started`: a status change, an item or a delta says nothing about a turn that may never begin", async () => {
    const turn = new MuseTurn(SID);
    turn.read("session/statusChanged", { sessionId: SID, status: "running" });
    turn.read("item/started", { sessionId: SID, item: { itemId: "i1", kind: "reasoning", status: "inProgress", summary: [] } });
    turn.read("item/delta", { sessionId: SID, itemId: "i1", delta: "x" });
    expect(turn.hasStarted).toBe(false);
    expect(await firedAfter(watchForSilence(turn, 5000), 6000)).toBe(true);
  });

  it("is cleared by `turn/started`, however quiet the host then goes", async () => {
    const turn = new MuseTurn(SID);
    const watch = watchForSilence(turn, 5000);
    turn.read("turn/started", { sessionId: SID, turnId: "t1" });
    expect(await firedAfter(watch, 60_000)).toBe(false);
  });

  it("is cleared by `turn/completed`", async () => {
    const turn = new MuseTurn(SID);
    const watch = watchForSilence(turn, 5000);
    turn.read("turn/completed", { sessionId: SID, turnId: "t1", terminal: "completed" });
    expect(turn.isCompleted).toBe(true);
    expect(await firedAfter(watch, 60_000)).toBe(false);
  });

  it("ignores another session's `turn/started`, a reminder child's say", async () => {
    const turn = new MuseTurn(SID);
    turn.read("turn/started", { sessionId: "01a13fb9-0000-7000-8000-000000000001", turnId: "t9" });
    expect(await firedAfter(watchForSilence(turn, 5000), 6000)).toBe(true);
  });

  it("can be cancelled", async () => {
    const turn = new MuseTurn(SID);
    const watch = watchForSilence(turn, 5000);
    watch.cancel();
    expect(await firedAfter(watch, 60_000)).toBe(false);
  });
});
