import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Real rows in a real database: what is under test is which parked rows
// "send now" folds into one, and what the one it keeps carries afterwards.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-queue-merge-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;
let mergePendingQueueItems: typeof import("../queue-merge.js").mergePendingQueueItems;

beforeAll(async () => {
  reg = await import("../registry.js");
  ({ mergePendingQueueItems } = await import("../queue-merge.js"));
  (await import("../../shared/db.js")).initDb();
});

const dispatch = (attachments: string[] = [], speechDerived = false) => ({ dispatch: { attachments, speechDerived } });
const pendingPrompts = (lane: string) =>
  reg.getQueueItems(lane).filter((row) => row.status === "pending").map((row) => row.prompt);

describe("mergePendingQueueItems", () => {
  it("folds every parked message into the target, in send order, with every attachment", () => {
    const lane = "lane-merge";
    const one = reg.enqueueQueueItem("s-merge", lane, "one", dispatch(["/a.png"]));
    const two = reg.enqueueQueueItem("s-merge", lane, "two", dispatch(["/b.png", "/a.png"], true));
    const now = reg.enqueueQueueItem("s-merge", lane, "now", dispatch(["/c.png"]));

    expect(mergePendingQueueItems(lane, now)).toEqual([one, two]);

    expect(pendingPrompts(lane)).toEqual(["one\n\ntwo\n\nnow"]);
    const merged = reg.getQueueItem(now)!;
    expect(merged.dispatch).toEqual({ attachments: ["/a.png", "/b.png", "/c.png"], speechDerived: true });
    expect(merged.position).toBe(reg.getQueueItem(one)!.position);
    expect(reg.getQueueItem(one)!.status).toBe("cancelled");
    expect(reg.getQueueItem(two)!.status).toBe("cancelled");
  });

  it("leaves internal rows and rows with no recorded dispatch where they are", () => {
    const lane = "lane-merge-skip";
    const callback = reg.enqueueQueueItem("s-merge", lane, "callback", { internal: true });
    const legacy = reg.enqueueQueueItem("s-merge", lane, "legacy");
    const parked = reg.enqueueQueueItem("s-merge", lane, "parked", dispatch());
    const now = reg.enqueueQueueItem("s-merge", lane, "now", dispatch());

    expect(mergePendingQueueItems(lane, now)).toEqual([parked]);

    expect(reg.getQueueItem(callback)!.status).toBe("pending");
    expect(reg.getQueueItem(legacy)!.status).toBe("pending");
    expect(reg.getQueueItem(now)!.prompt).toBe("parked\n\nnow");
  });

  it("does nothing with a single parked row or a target that is not parked", () => {
    const lane = "lane-merge-none";
    const only = reg.enqueueQueueItem("s-merge", lane, "only", dispatch());
    expect(mergePendingQueueItems(lane, only)).toEqual([]);
    reg.enqueueQueueItem("s-merge", lane, "second", dispatch());
    expect(mergePendingQueueItems(lane, "no-such-row")).toEqual([]);
    expect(pendingPrompts(lane)).toEqual(["only", "second"]);
  });
});
