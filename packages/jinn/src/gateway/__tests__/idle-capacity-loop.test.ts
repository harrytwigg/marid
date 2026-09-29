import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LAPSING, NOT_LAPSING,
  backlog, clearBoard, closeAll, config, loadModules, minutes, modules, open, snapshot, started, week,
} from "./idle-capacity-harness.js";

/**
 * the loop's guards and its choice of Todo. Tier selection and the
 * operator signals are in idle-capacity-tiers.test.ts; the seam to the real
 * Dispatcher in idle-capacity-route.test.ts.
 */

beforeAll(loadModules);
afterEach(() => { closeAll(); clearBoard(); });

describe("idle-capacity auto-start guards", () => {
  it("does nothing unless the feature is enabled", async () => {
    backlog("Idle work");
    const h = open({ idleCapacity: undefined });
    const result = await h.loop.tick();
    expect(result.reason).toBe("disabled");
    expect(h.dispatched).toEqual([]);
  });

  it("holds while capacity is not idle for the tier", async () => {
    backlog("Idle work");
    const h = open({ active: 1 });
    expect((await h.loop.tick()).reason).toBe("1 session(s) already hold engine capacity (daytime tier allows fewer than 1)");
    expect(h.dispatched).toEqual([]);
  });

  it("holds on the verdict's own reason when no window is lapsing", async () => {
    backlog("Idle work");
    const h = open({ reading: NOT_LAPSING });
    const result = await h.loop.tick();
    expect(result.reason).toMatch(/^daytime tier, no window within its lookahead/);
    expect(result.verdict?.act).toBe(false);
    expect(h.dispatched).toEqual([]);
  });

  it("holds when the Claude reading is unusable rather than guessing", async () => {
    backlog("Idle work");
    const h = open({ reading: { ...LAPSING, status: "error", windows: undefined } });
    expect((await h.loop.tick()).reason).toBe("no usable Claude limits reading (status error)");
    expect(h.dispatched).toEqual([]);
  });
});

describe("idle-capacity auto-start dispatching", () => {
  it("starts one eligible backlog Todo per tick, highest priority then oldest first, and says why on the Todo", async () => {
    const low = backlog("Low priority", { priority: 1 });
    const oldHigh = backlog("Old high", { priority: 3 });
    const newHigh = backlog("New high", { priority: 3 });
    const h = open();

    const first = await h.loop.tick();
    expect(first.started).toEqual({ workItemId: oldHigh.id, sessionId: `sess-${oldHigh.id}` });
    expect(first.reason).toBe(`started ${oldHigh.id}`);
    expect(first.tier).toBe("daytime");
    expect(h.dispatched).toEqual([oldHigh.id]);

    const note = modules.comments.listComments(oldHigh.id).comments.at(-1);
    expect(note?.authorKind).toBe("system");
    expect(note?.author).toBe(modules.loop.IDLE_CAPACITY_ACTOR);
    expect(note?.body).toContain("daytime tier, five-hour window about to lapse: 5h 15% used, resets in 40 min");
    expect(note?.body).toContain(`session sess-${oldHigh.id}`);
    expect(note?.body).toContain("1 of 2 for this five-hour window");

    const second = await h.loop.tick();
    expect(second.started?.workItemId).toBe(newHigh.id);
    const third = await h.loop.tick();
    expect(third.started).toBeUndefined();
    expect(third.reason).toBe("2 Todo(s) already started in this five-hour window (daytime tier cap 2)");
    expect(h.dispatched).not.toContain(low.id);
  });

  it("charges the cap to the five-hour window by its reset, so a new window starts afresh and a re-read does not re-key it", async () => {
    backlog("A"); backlog("B"); backlog("C"); backlog("D");
    let reading = LAPSING;
    // Jinn's own started session is what moves the numbers between ticks here.
    const h = open({ idleCapacity: { enabled: true, tiers: { daytime: { maxDispatchesPerWindow: 1 } } }, reading: () => reading, jinnActiveSince: () => true });
    expect((await h.loop.tick()).started).toBeDefined();
    expect((await h.loop.tick()).reason).toBe("1 Todo(s) already started in this five-hour window (daytime tier cap 1)");
    // Same window read again a little later: still charged, still capped.
    reading = snapshot([{ name: "5h", usedPercent: 25, resetsAt: minutes(40) }, week()]);
    expect((await h.loop.tick()).reason).toMatch(/^1 Todo\(s\) already started/);
    // The next window: not lapsing yet…
    reading = snapshot([{ name: "5h", usedPercent: 2, resetsAt: minutes(40 + 300) }, week()]);
    expect((await h.loop.tick()).reason).toMatch(/no window within its lookahead/);
    // …and lapsing again means a fresh allowance, once.
    reading = snapshot([{ name: "5h", usedPercent: 2, resetsAt: minutes(100) }, week()]);
    expect((await h.loop.tick()).started).toBeDefined();
    expect((await h.loop.tick()).reason).toMatch(/^1 Todo\(s\) already started/);
    expect(h.dispatched).toHaveLength(2);
  });

  it("skips Todos that opted out, are pinned to another engine, carry a pending approval, or lack a required label", async () => {
    const { labels, dispatchConfig, approvals } = modules;
    labels.createLabel({ name: "no-auto-start" });
    labels.createLabel({ name: "idle-ok" });
    const optOut = backlog("Opted out by label");
    labels.addWorkItemLabels(optOut.id, ["no-auto-start"], "test");
    const flagged = backlog("Opted out by flag");
    dispatchConfig.setTodoDispatchConfig(flagged.id, { autoStart: false }, config(undefined));
    const pinned = backlog("Pinned to OpenCode");
    dispatchConfig.setTodoDispatchConfig(pinned.id, { engine: "opencode" }, config(undefined));
    const asking = backlog("Awaiting approval");
    approvals.requestApproval(asking.id, { request: "may I?" });
    const fine = backlog("Fine");

    const h = open();
    const result = await h.loop.tick();
    expect(result.started?.workItemId).toBe(fine.id);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { workItemId: optOut.id, reason: "label no-auto-start" },
      { workItemId: flagged.id, reason: "autoStart is false" },
      { workItemId: pinned.id, reason: "dispatch override names engine opencode" },
      { workItemId: asking.id, reason: "an approval is pending" },
    ]));

    // With an opt-in label required, an unlabelled Todo is passed over.
    const unlabelled = backlog("Not opted in");
    const strict = open({ idleCapacity: { enabled: true, requireLabel: "idle-ok" } });
    const held = await strict.loop.tick();
    expect(held.started).toBeUndefined();
    expect(held.skipped).toEqual(expect.arrayContaining([{ workItemId: unlabelled.id, reason: "no idle-ok label" }]));
    labels.addWorkItemLabels(unlabelled.id, ["idle-ok"], "test");
    expect((await strict.loop.tick()).started?.workItemId).toBe(unlabelled.id);
  });

  // a park is `blocked` + `parkedUntil`, so the loop never lists it —
  // and when the date passes it comes back to the queue on its own. The old
  // version of this wrote a stop cause onto a backlog Todo, a state no real
  // write can produce, which is how a skip rule that could never fire passed.
  it("never sees a parked Todo, and starts it once its park has run out", async () => {
    const { transition } = await import("../../work-items/transitions.js");
    const { releaseExpiredParks } = await import("../../work-items/park-expiry.js");
    const parked = backlog("Run on or after the 1st", { priority: 3 });
    const until = new Date(Date.now() + 9 * 24 * 60 * 60_000).toISOString();
    transition(parked.id, "blocked", "session:agent", { agent: true, stopCause: { parkedUntil: until }, detail: { note: "date-gated" } });
    const other = backlog("Ordinary work", { priority: 1 });

    const h = open();
    const first = await h.loop.tick();
    expect(first.started?.workItemId).toBe(other.id);
    expect(first.skipped.map((skip) => skip.workItemId)).not.toContain(parked.id);
    expect(h.dispatched).not.toContain(parked.id);

    releaseExpiredParks(new Date(Date.parse(until) + 1_000));
    expect(modules.store.getWorkItem(parked.id)?.status).toBe("backlog");
    expect((await h.loop.tick()).started?.workItemId).toBe(parked.id);
  });

  it("moves on to the next Todo when a dispatch is refused, and reports the refusal", async () => {
    const claimed = backlog("Already claimed", { priority: 3 });
    const free = backlog("Free", { priority: 2 });
    const h = open({
      dispatch: (item) => item.id === claimed.id
        ? { ok: false, status: 409, body: { error: `Todo ${item.id} is already being worked by someone`, workItemId: item.id } }
        : started(item),
    });
    const result = await h.loop.tick();
    expect(result.started?.workItemId).toBe(free.id);
    expect(result.skipped).toEqual([{ workItemId: claimed.id, reason: `Todo ${claimed.id} is already being worked by someone` }]);
    expect(modules.comments.listComments(claimed.id).total).toBe(0);
  });

  it("previews the next tick without starting anything, and keeps the window count on a later hold", async () => {
    const item = backlog("Would start");
    backlog("Next");
    let active = 0;
    const h = open({ active: () => active });
    const preview = await h.loop.preview();
    expect(preview.reason).toBe(`would start ${item.id}`);
    expect(preview.eligible[0]).toEqual({ workItemId: item.id, title: "Would start", priority: 2 });
    expect(preview.startedThisWindow).toBe(0);
    expect(preview.tier).toBe("daytime");
    expect(preview.operator).toEqual({ live: false });
    expect(preview.quietHours).toBe(false);
    expect(preview.verdict?.act).toBe(true);
    expect(h.dispatched).toEqual([]);

    expect((await h.loop.tick()).started?.workItemId).toBe(item.id);
    // The started session now holds capacity: the loop holds, and the preview
    // still reports the start charged to this window.
    active = 1;
    const after = await h.loop.preview();
    expect(after.reason).toMatch(/^1 session\(s\) already hold engine capacity/);
    expect(after.startedThisWindow).toBe(1);
  });
});
