import { describe, expect, it } from "vitest";
import {
  appendPluginEvent,
  PLUGIN_EVENT_RING_SIZE,
  readPluginEvents,
  subscribePluginEvents,
} from "../event-log.js";

/** Rings are process-wide and never cleared, so every case names its own plugin. */
let counter = 0;
function freshId(): string {
  return `ring-${counter++}`;
}

describe("appendPluginEvent", () => {
  it("hands a reader everything a plugin has emitted, in order", () => {
    const id = freshId();
    appendPluginEvent(id, { kind: "arrived" });
    appendPluginEvent(id, { kind: "left" });

    const page = readPluginEvents(id);
    expect(page.events).toEqual([
      { cursor: 1, event: { kind: "arrived" } },
      { cursor: 2, event: { kind: "left" } },
    ]);
    expect(page.cursor).toBe(2);
    expect(page.dropped).toBe(false);
  });

  it("refuses an event that cannot survive the wire", () => {
    const id = freshId();
    expect(() => appendPluginEvent(id, undefined)).toThrow(TypeError);
    expect(() => appendPluginEvent(id, () => {})).toThrow(/JSON-serializable/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => appendPluginEvent(id, circular)).toThrow(/JSON-serializable/);
    expect(readPluginEvents(id).events).toEqual([]);
  });

  it("keeps one plugin's events out of another's ring", () => {
    const mine = freshId();
    const theirs = freshId();
    appendPluginEvent(mine, "mine");

    expect(readPluginEvents(theirs).events).toEqual([]);
    expect(readPluginEvents(mine).events).toHaveLength(1);
  });
});

describe("the ring's bound", () => {
  it("drops the oldest past the cap without growing or reusing a cursor", () => {
    const id = freshId();
    const overflow = PLUGIN_EVENT_RING_SIZE * 10;
    for (let n = 1; n <= overflow; n++) appendPluginEvent(id, n);

    const page = readPluginEvents(id);
    expect(page.events).toHaveLength(PLUGIN_EVENT_RING_SIZE);
    // The cursor counts every event the plugin ever emitted, not the survivors.
    expect(page.cursor).toBe(overflow);
    expect(page.events[0].cursor).toBe(overflow - PLUGIN_EVENT_RING_SIZE + 1);
    const cursors = page.events.map((record) => record.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(new Set(cursors).size).toBe(cursors.length);
  });
});

describe("readPluginEvents", () => {
  it("returns only what came after the caller's cursor", () => {
    const id = freshId();
    appendPluginEvent(id, "one");
    appendPluginEvent(id, "two");
    appendPluginEvent(id, "three");

    const page = readPluginEvents(id, 1);
    expect(page.events.map((record) => record.event)).toEqual(["two", "three"]);
    expect(page.cursor).toBe(3);
    expect(page.dropped).toBe(false);
  });

  it("says nothing was dropped when the caller is exactly caught up", () => {
    const id = freshId();
    appendPluginEvent(id, "only");
    expect(readPluginEvents(id, 1)).toEqual({ events: [], cursor: 1, dropped: false });
  });

  it("says so when the caller's cursor predates the oldest survivor", () => {
    const id = freshId();
    for (let n = 0; n <= PLUGIN_EVENT_RING_SIZE; n++) appendPluginEvent(id, n);

    // Cursor 1 was evicted by the last append, so a reader sitting at 0 missed it.
    const missed = readPluginEvents(id, 0);
    expect(missed.dropped).toBe(true);
    expect(missed.events).toHaveLength(PLUGIN_EVENT_RING_SIZE);
    // The reader one event later lost nothing: the next event it wants is retained.
    expect(readPluginEvents(id, 1).dropped).toBe(false);
  });

  it("reports an empty ring rather than inventing a cursor", () => {
    expect(readPluginEvents(freshId(), 0)).toEqual({ events: [], cursor: 0, dropped: false });
  });
});

describe("subscribePluginEvents", () => {
  it("delivers appends until the subscriber goes away", () => {
    const id = freshId();
    const seen: number[] = [];
    const unsubscribe = subscribePluginEvents(id, (record) => seen.push(record.cursor));

    appendPluginEvent(id, "live");
    unsubscribe();
    appendPluginEvent(id, "after");

    expect(seen).toEqual([1]);
  });

  it("does not deliver another plugin's events", () => {
    const mine = freshId();
    const theirs = freshId();
    const seen: unknown[] = [];
    subscribePluginEvents(mine, (record) => seen.push(record.event));

    appendPluginEvent(theirs, "theirs");

    expect(seen).toEqual([]);
  });
});
