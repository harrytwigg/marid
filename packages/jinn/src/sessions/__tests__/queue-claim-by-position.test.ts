import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Real rows, real SessionQueue: what is under test is the order a lane claims
// its rows in, and that each row runs the dispatch it was enqueued with.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-queue-claim-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;
let SessionQueue: typeof import("../queue.js").SessionQueue;

beforeAll(async () => {
  reg = await import("../registry.js");
  ({ SessionQueue } = await import("../queue.js"));
  (await import("../../shared/db.js")).initDb();
});

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lane whose first turn blocks, with `names` parked behind it as rows with their own dispatch. */
function parkedLane(lane: string, names: string[], options: { internal?: string[] } = {}) {
  const queue = new SessionQueue();
  const ran: string[] = [];
  const ids = new Map<string, string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const head = reg.enqueueQueueItem("s-claim", lane, "running");
  const settled: Array<Promise<void>> = [
    queue.enqueue(lane, async () => { ran.push("running"); await gate; }, head),
  ];
  for (const name of names) {
    const id = reg.enqueueQueueItem("s-claim", lane, name, { internal: options.internal?.includes(name) });
    ids.set(name, id);
    settled.push(queue.enqueue(lane, async () => { ran.push(name); }, id));
  }
  return { queue, ran, ids, release: () => release(), done: () => Promise.all(settled) };
}

describe("SessionQueue claims the next row by position", () => {
  it("runs a promoted row's own dispatch next, and every row keeps its id", async () => {
    const lane = "lane-promote";
    const { queue, ran, ids, release, done } = parkedLane(lane, ["a", "b", "c"]);
    await tick();
    expect(queue.isRunning(lane)).toBe(true);

    expect(reg.promotePendingQueueItem(lane, ids.get("c")!)).toBe(true);

    for (const [name, id] of ids) expect(reg.getQueueItem(id)?.prompt).toBe(name);
    expect(reg.getQueueItems(lane).filter((row) => row.status === "pending").map((row) => row.prompt)).toEqual(["c", "a", "b"]);
    release();
    await done();
    expect(ran).toEqual(["running", "c", "a", "b"]);
    for (const id of ids.values()) expect(reg.getQueueItem(id)?.status).toBe("completed");
  });

  it("promoting is a no-op for the head and refuses a row that is not parked", async () => {
    const lane = "lane-noop";
    const { ran, ids, release, done } = parkedLane(lane, ["a", "b"]);
    await tick();

    expect(reg.promotePendingQueueItem(lane, ids.get("a")!)).toBe(true);
    expect(reg.promotePendingQueueItem(lane, "no-such-row")).toBe(false);

    release();
    await done();
    expect(ran).toEqual(["running", "a", "b"]);
  });

  it("leaves an internal row where it was while visible rows are reordered around it", async () => {
    const lane = "lane-internal";
    const { ran, ids, release, done } = parkedLane(lane, ["a", "callback", "b"], { internal: ["callback"] });
    await tick();

    reg.promotePendingQueueItem(lane, ids.get("b")!);

    release();
    await done();
    expect(ran).toEqual(["running", "b", "callback", "a"]);
  });

  it("settles each caller with its own row's outcome, whichever slot ran it", async () => {
    const lane = "lane-errors";
    const queue = new SessionQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const head = queue.enqueue(lane, () => gate, reg.enqueueQueueItem("s-claim", lane, "running"));
    const okId = reg.enqueueQueueItem("s-claim", lane, "ok");
    const failId = reg.enqueueQueueItem("s-claim", lane, "fails");
    const ok = queue.enqueue(lane, async () => {}, okId);
    const fails = queue.enqueue(lane, async () => { throw new Error("boom"); }, failId);
    const outcomes = Promise.allSettled([ok, fails]);
    await tick();

    reg.promotePendingQueueItem(lane, failId);
    release();
    await head;

    const [okOutcome, failsOutcome] = await outcomes;
    expect(okOutcome.status).toBe("fulfilled");
    expect(failsOutcome).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "boom" }) });
    expect(reg.getQueueItem(failId)?.status).toBe("completed");
  });

  it("skips a cancelled row without running another row twice", async () => {
    const lane = "lane-cancel";
    const { ran, ids, release, done } = parkedLane(lane, ["a", "b", "c"]);
    await tick();

    reg.cancelQueueItem(ids.get("a")!);
    reg.promotePendingQueueItem(lane, ids.get("c")!);

    release();
    await done();
    expect(ran).toEqual(["running", "c", "b"]);
    expect(queueDrained(lane)).toBe(true);
  });

  it("claims by position again when the lane resumes from a pause", async () => {
    const lane = "lane-pause";
    const queue = new SessionQueue();
    const ran: string[] = [];
    const first = reg.enqueueQueueItem("s-claim", lane, "first");
    const second = reg.enqueueQueueItem("s-claim", lane, "second");
    queue.pauseQueue(lane);
    const a = queue.enqueue(lane, async () => { ran.push("first"); }, first);
    const b = queue.enqueue(lane, async () => { ran.push("second"); }, second);
    await tick();
    expect(ran).toEqual([]);

    reg.promotePendingQueueItem(lane, second);
    queue.resumeQueue(lane);
    await Promise.all([a, b]);

    expect(ran).toEqual(["second", "first"]);
  });

  it("waits on a callback hold for the row at the head, then runs the lane", async () => {
    const lane = "lane-hold";
    const queue = new SessionQueue();
    const ran: string[] = [];
    const callback = reg.enqueueQueueItem("s-claim", lane, "callback", { internal: true });
    const visible = reg.enqueueQueueItem("s-claim", lane, "visible");
    queue.holdForCallbackDrain(lane, callback);
    const a = queue.enqueue(lane, async () => { ran.push("callback"); }, callback);
    const b = queue.enqueue(lane, async () => { ran.push("visible"); }, visible);
    await tick();
    expect(ran).toEqual([]);

    queue.releaseCallbackDrain(lane, callback);
    await Promise.all([a, b]);

    expect(ran).toEqual(["callback", "visible"]);
  });

  it("promotes past a tie: rows left sharing a position by a restart", async () => {
    const lane = "lane-tied";
    const { ran, ids, release, done } = parkedLane(lane, ["a", "b", "c"]);
    await tick();
    (await import("../../shared/db.js")).initDb()
      .prepare("UPDATE queue_items SET position = 50 WHERE session_key = ? AND status = 'pending'").run(lane);

    reg.promotePendingQueueItem(lane, ids.get("c")!);

    release();
    await done();
    expect(ran).toEqual(["running", "c", "a", "b"]);
  });

  it("rejects the caller and frees the row when the store fails while claiming it", async () => {
    const lane = "lane-store-fails";
    const db = (await import("../../shared/db.js")).initDb();
    const queue = new SessionQueue();
    const id = reg.enqueueQueueItem("s-claim", lane, "doomed");
    db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE ON queue_items WHEN NEW.id = '${id}' AND NEW.status = 'running'
             BEGIN SELECT RAISE(ABORT, 'store busy'); END`);
    try {
      await expect(queue.enqueue(lane, async () => {}, id)).rejects.toThrow("store busy");
    } finally {
      db.exec("DROP TRIGGER fail_claim");
    }

    expect(queue.hasInFlightItem(id)).toBe(false);
    expect(queue.isRunning(lane)).toBe(false);
    expect(queue.getPendingCount(lane)).toBe(0);
  });

  it("lists pending rows for boot replay in the order the lane will claim them", async () => {
    const lane = "lane-replay";
    const { ids, release, done } = parkedLane(lane, ["a", "b", "c"]);
    await tick();
    reg.promotePendingQueueItem(lane, ids.get("c")!);

    const replay = reg.listAllPendingQueueItems().filter((row) => row.sessionKey === lane).map((row) => row.prompt);

    expect(replay).toEqual(["c", "a", "b"]);
    release();
    await done();
  });
});

function queueDrained(lane: string): boolean {
  return reg.getQueueItems(lane).length === 0;
}
