import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionQueue } from "../queue.js";

// the two places a dispatched turn can end without a spawn — parked
// behind the lane, or let through only to find its row no longer runnable —
// must each leave a line in the log. Stub the registry rows and the logger.
const rows = new Map<string, { sessionId: string; status: string }>();
vi.mock("../registry.js", () => ({
  getQueueItem: vi.fn((id: string) => rows.get(id)),
  markQueueItemRunning: vi.fn((id: string) => rows.get(id)?.status === "pending"),
  markQueueItemCompleted: vi.fn(),
}));
const info = vi.fn();
const warn = vi.fn();
vi.mock("../../shared/logger.js", () => ({ logger: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a) } }));

beforeEach(() => {
  rows.clear();
  info.mockClear();
  warn.mockClear();
});

describe("SessionQueue says why a turn did not start", () => {
  it("logs a turn enqueued behind another on its lane, naming the owning session", async () => {
    const queue = new SessionQueue();
    rows.set("row-a", { sessionId: "sess-a", status: "pending" });
    rows.set("row-b", { sessionId: "sess-b", status: "pending" });
    let releaseA: (() => void) | undefined;
    const a = queue.enqueue("lane", () => new Promise<void>((resolve) => { releaseA = resolve; }), "row-a");
    while (!queue.isRunning("lane")) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(info).not.toHaveBeenCalled();

    const b = queue.enqueue("lane", async () => {}, "row-b");
    expect(info).toHaveBeenCalledWith("Session sess-b turn row-b queued behind 1 turn(s) on lane lane");

    releaseA?.();
    await a;
    await b;
  });

  it("warns when the lane lets a turn through but its row is no longer runnable", async () => {
    const queue = new SessionQueue();
    rows.set("row-cancelled", { sessionId: "sess-c", status: "cancelled" });
    let ran = false;
    await queue.enqueue("lane-2", async () => { ran = true; }, "row-cancelled");
    expect(ran).toBe(false);
    expect(warn).toHaveBeenCalledWith("Turn row-cancelled on lane lane-2 skipped: queue row is cancelled");

    await queue.enqueue("lane-2", async () => { ran = true; }, "row-missing");
    expect(ran).toBe(false);
    expect(warn).toHaveBeenCalledWith("Turn row-missing on lane lane-2 skipped: queue row is gone");
  });

  it("stays quiet for a turn that starts straight away", async () => {
    const queue = new SessionQueue();
    rows.set("row-now", { sessionId: "sess-n", status: "pending" });
    let ran = false;
    await queue.enqueue("lane-3", async () => { ran = true; }, "row-now");
    expect(ran).toBe(true);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
