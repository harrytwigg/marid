import { describe, expect, it } from "vitest";
import { FreebuffSlots } from "../freebuff-slots.js";

function make(max = 1) {
  const cap = { max };
  const evicted: string[] = [];
  let t = 0;
  const slots = new FreebuffSlots({ max: () => cap.max, evict: (id) => evicted.push(id), now: () => ++t });
  return { slots, cap, evicted };
}

const settled = (p: Promise<unknown>) => Promise.race([p.then(() => "granted", () => "rejected"), Promise.resolve().then(() => Promise.resolve()).then(() => "pending")]);

describe("FreebuffSlots", () => {
  it("grants up to the cap at once and queues the rest first in first out", async () => {
    const { slots } = make(2);
    await slots.acquire("a");
    await slots.acquire("b");
    const order: string[] = [];
    const c = slots.acquire("c").then(() => order.push("c"));
    const d = slots.acquire("d").then(() => order.push("d"));
    expect(slots.used).toBe(2);
    expect(slots.waiting).toBe(2);
    slots.release("a");
    await c;
    expect(order).toEqual(["c"]);
    slots.release("b");
    await d;
    expect(order).toEqual(["c", "d"]);
    expect(slots.waiting).toBe(0);
  });

  it("does not fail a queued turn: it waits for a busy slot to finish", async () => {
    const { slots, evicted } = make(1);
    await slots.acquire("a");
    const b = slots.acquire("b");
    expect(await settled(b)).toBe("pending");
    expect(evicted).toEqual([]); // a is busy, never taken
    slots.markIdle("a");
    await b;
    expect(evicted).toEqual(["a"]);
    expect(slots.holds("b")).toBe(true);
    expect(slots.holds("a")).toBe(false);
  });

  it("takes over the idle slot that has waited longest", async () => {
    const { slots, evicted } = make(2);
    await slots.acquire("a");
    await slots.acquire("b");
    slots.markIdle("b");
    slots.markIdle("a");
    await slots.acquire("c");
    expect(evicted).toEqual(["b"]);
    expect(slots.used).toBe(2);
  });

  it("lets a session with a live process run again without a new slot", async () => {
    const { slots, evicted } = make(1);
    await slots.acquire("a");
    slots.markIdle("a");
    await slots.acquire("a");
    expect(slots.stateOf("a")).toBe("busy");
    expect(evicted).toEqual([]);
  });

  it("frees the slot when the process goes away", async () => {
    const { slots } = make(1);
    await slots.acquire("a");
    const b = slots.acquire("b");
    slots.release("a");
    await b;
    expect(slots.holds("b")).toBe(true);
    slots.release("a"); // already gone: nothing happens
    expect(slots.used).toBe(1);
  });

  it("drops an aborted waiter from the queue and rejects it", async () => {
    const { slots } = make(1);
    await slots.acquire("a");
    const ac = new AbortController();
    const b = slots.acquire("b", ac.signal);
    const c = slots.acquire("c");
    ac.abort(new Error("stopped"));
    await expect(b).rejects.toThrow("stopped");
    expect(slots.waiting).toBe(1);
    slots.release("a");
    await c;
    expect(slots.holds("b")).toBe(false);
  });

  it("rejects at once when already aborted", async () => {
    const { slots } = make(1);
    const ac = new AbortController();
    ac.abort();
    await expect(slots.acquire("a", ac.signal)).rejects.toThrow();
    expect(slots.used).toBe(0);
  });

  it("follows a cap that changes while running", async () => {
    const { slots, cap } = make(1);
    await slots.acquire("a");
    const b = slots.acquire("b");
    expect(slots.waiting).toBe(1);
    cap.max = 2;
    slots.release("zzz"); // a no-op release does not drain
    expect(slots.waiting).toBe(1);
    slots.markIdle("a"); // any state change re-checks
    await b;
    expect(slots.holds("a")).toBe(true); // 2 slots now: no need to take a's
    expect(slots.holds("b")).toBe(true);
  });

  it("gives the terminal view a slot only when one is free or idle, and never queues it", async () => {
    const { slots, evicted } = make(1);
    expect(slots.tryAcquireIdle("view")).toBe(true);
    expect(slots.stateOf("view")).toBe("idle");
    await slots.acquire("turn"); // takes over the idle view
    expect(evicted).toEqual(["view"]);
    expect(slots.tryAcquireIdle("view2")).toBe(false); // the turn is busy
    expect(slots.waiting).toBe(0);
  });

  it("treats a nonsense cap as one", async () => {
    const { slots, cap } = make(0);
    cap.max = Number.NaN;
    await slots.acquire("a");
    const b = slots.acquire("b");
    expect(slots.waiting).toBe(1);
    slots.release("a");
    await b;
  });

  it("rejects everything queued on shutdown", async () => {
    const { slots } = make(1);
    await slots.acquire("a");
    const b = slots.acquire("b");
    slots.rejectAll(new Error("shutting down"));
    await expect(b).rejects.toThrow("shutting down");
  });
});
