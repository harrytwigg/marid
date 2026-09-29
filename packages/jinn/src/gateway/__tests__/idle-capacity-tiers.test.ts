import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  NIGHT, NOT_LAPSING, NOW,
  backlog, clearBoard, closeAll, config, loadModules, minutes, modules, open, snapshot, week,
} from "./idle-capacity-harness.js";

/**
 * which tier a tick runs under, how the operator is recognised as
 * live, and the timer. The guards and the choice of Todo are in
 * idle-capacity-loop.test.ts.
 */

beforeAll(loadModules);
afterEach(() => { closeAll(); clearBoard(); });

describe("idle-capacity tiers", () => {
  it("runs the overnight tier in the quiet hours and spends deep into the window", async () => {
    backlog("Night work");
    // 4 h to reset at 60% used: daytime would hold on both the ceiling and
    // the lookahead; overnight looks the whole window ahead and spends to 85%.
    const reading = snapshot([{ name: "5h", usedPercent: 60, resetsAt: minutes(240, NIGHT) }, week(NIGHT)], NIGHT);
    const h = open({ reading, now: NIGHT });
    const result = await h.loop.tick();
    expect(result.tier).toBe("overnight");
    expect(result.started).toBeDefined();
    expect(result.verdict?.reason).toMatch(/^overnight tier, five-hour window about to lapse: 5h 60% used, resets in 4 h/);

    // The same reading by day holds.
    backlog("Day work");
    const day = open({ reading: snapshot([{ name: "5h", usedPercent: 60, resetsAt: minutes(240) }, week()]) });
    const held = await day.loop.tick();
    expect(held.tier).toBe("daytime");
    expect(held.reason).toBe("5h 60% used, resets in 4 h — above the 50% five-hour ceiling");
  });

  it("keeps the overnight hard floor", async () => {
    backlog("Night work");
    const reading = snapshot([{ name: "5h", usedPercent: 90, resetsAt: minutes(30, NIGHT) }, week(NIGHT)], NIGHT);
    const h = open({ reading, now: NIGHT });
    const result = await h.loop.tick();
    expect(result.tier).toBe("overnight");
    expect(result.reason).toBe("5h 90% used, resets in 30 min — above the 85% five-hour ceiling");
    expect(h.dispatched).toEqual([]);
  });

  it("backs off to the interactive tier while a Jinn interactive Claude session is recent, at any hour", async () => {
    backlog("Work");
    // A statusline snapshot written 10 minutes ago: the operator is at the
    // dashboard's CLI. 15% used with 40 min to go passes daytime, but the
    // interactive tier wants the window nearly untouched and in its last half hour.
    const h = open({ now: NIGHT, reading: snapshot([{ name: "5h", usedPercent: 15, resetsAt: minutes(40, NIGHT) }, week(NIGHT)], NIGHT), interactiveActivityAt: () => NIGHT - 10 * 60_000 });
    const result = await h.loop.tick();
    expect(result.tier).toBe("interactive");
    expect(result.reason).toMatch(/^interactive tier, no window within its lookahead \(5h: 30 min/);
    const preview = await h.loop.preview();
    expect(preview.operator).toEqual({ live: true, seenAt: NIGHT - 10 * 60_000, source: "jinn-interactive-session" });
    expect(preview.quietHours).toBe(true);

    // The interactive tier does still act, barely: nearly empty and about to lapse.
    const barely = open({ reading: snapshot([{ name: "5h", usedPercent: 5, resetsAt: minutes(20) }, week()]), interactiveActivityAt: () => NOW - 60_000 });
    const acted = await barely.loop.tick();
    expect(acted.tier).toBe("interactive");
    expect(acted.started).toBeDefined();
    expect((await barely.loop.tick()).reason).toBe("1 Todo(s) already started in this five-hour window (interactive tier cap 1)");
  });

  it("lets the operator's presence expire after idleMinutes", async () => {
    backlog("Work");
    const h = open({ interactiveActivityAt: () => NOW - 31 * 60_000 });
    const result = await h.loop.tick();
    expect(result.tier).toBe("daytime");
    expect(result.started).toBeDefined();
  });

  it("reads five-hour usage that rose while no Jinn session ran as the operator, and Jinn's own spend as not", async () => {
    backlog("A"); backlog("B");
    let now = NOW;
    let used = 10;
    let jinnActive = false;
    const h = open({
      now: () => now,
      reading: () => snapshot([{ name: "5h", usedPercent: used, resetsAt: minutes(200) }, week()]),
      jinnActiveSince: () => jinnActive,
    });
    expect((await h.loop.tick()).tier).toBe("daytime");
    // +1 point: under the 2-point delta, still nobody.
    now += 10 * 60_000; used = 11;
    expect((await h.loop.tick()).tier).toBe("daytime");
    // +3 points with Jinn busy in between: Jinn's own spend.
    now += 10 * 60_000; used = 14; jinnActive = true;
    expect((await h.loop.tick()).tier).toBe("daytime");
    // +3 points with nothing of Jinn's running: the operator, somewhere.
    now += 10 * 60_000; used = 17; jinnActive = false;
    const seen = await h.loop.tick();
    expect(seen.tier).toBe("interactive");
    expect((await h.loop.preview()).operator).toEqual({ live: true, seenAt: now, source: "usage-outside-jinn" });
    // Half an hour of quiet later, daytime again.
    now += 31 * 60_000;
    expect((await h.loop.tick()).tier).toBe("daytime");
  });

  it("does not read a new window's lower number as the operator", async () => {
    let now = NOW;
    let reading = snapshot([{ name: "5h", usedPercent: 40, resetsAt: minutes(200) }, week()]);
    const h = open({ now: () => now, reading: () => reading });
    await h.loop.tick();
    now += 10 * 60_000;
    reading = snapshot([{ name: "5h", usedPercent: 5, resetsAt: minutes(500) }, week()]);
    await h.loop.tick();
    now += 10 * 60_000;
    reading = snapshot([{ name: "5h", usedPercent: 6, resetsAt: minutes(500) }, week()]);
    expect((await h.loop.tick()).tier).toBe("daytime");
    expect((await h.loop.preview()).operator).toEqual({ live: false });
  });

  it("does not let a preview between two ticks hide the usage-outside-Jinn signal", async () => {
    backlog("A");
    let now = NOW;
    let used = 10;
    const h = open({ now: () => now, reading: () => snapshot([{ name: "5h", usedPercent: used, resetsAt: minutes(200) }, week()]) });
    expect((await h.loop.tick()).tier).toBe("daytime");
    // Halfway through the interval the operator looks at the page: +1 so far.
    now += 5 * 60_000; used = 11;
    expect((await h.loop.preview()).tier).toBe("daytime");
    // The next tick measures the whole +2 from the last TICK, not from the preview.
    now += 5 * 60_000; used = 12;
    expect((await h.loop.tick()).tier).toBe("interactive");
  });

  it("reads a recent operator-driven chat as the operator being live, with no turn running", async () => {
    backlog("Work");
    const h = open({
      reading: snapshot([{ name: "5h", usedPercent: 15, resetsAt: minutes(40) }, week()]),
      operatorSessionActivityAt: () => NOW - 4 * 60_000,
    });
    const result = await h.loop.tick();
    expect(result.tier).toBe("interactive");
    expect(result.started).toBeUndefined();
    expect((await h.loop.preview()).operator).toEqual({ live: true, seenAt: NOW - 4 * 60_000, source: "operator-session" });
  });

  it("honours a tier switched off in config", async () => {
    backlog("Work");
    const h = open({ idleCapacity: { enabled: true, tiers: { daytime: { enabled: false } } } });
    expect((await h.loop.tick()).reason).toBe("the daytime tier is switched off");
    expect(h.dispatched).toEqual([]);
  });
});

describe("idle-capacity auto-start timer", () => {
  it("fires on the configured cadence, re-reads it each time, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      let interval = 10;
      const ticks: number[] = [];
      const l = modules.loop.startIdleCapacityAutoStart({
        getConfig: () => config({ enabled: true, intervalMinutes: interval }),
        context: {} as never,
        collect: async () => { ticks.push(Date.now()); return NOT_LAPSING; },
        activeSessions: () => 0,
        jinnActiveSince: () => false,
        interactiveActivityAt: () => undefined,
        operatorSessionActivityAt: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(ticks).toHaveLength(0);
      // Changed before the first fire: the fire after it is scheduled from the
      // config as it is then, not from the cadence the loop booted with.
      interval = 2;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ticks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(ticks).toHaveLength(2);
      l.stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(ticks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
