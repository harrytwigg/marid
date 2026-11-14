import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB (SESSIONS_DB resolves from HUNDREDFOLD_HOME at module load).
process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-label-change-"));

/* The body grammar of `PUT /api/work-items/:id/labels`: `labels` is the whole set
 * and replaces it, `add` and `remove` name only what changes. One mode per call,
 * because "replace the set" and "change one label" are different intentions and a
 * body carrying both would have to guess which was meant. */

type Store = typeof import("../../work-items/store.js");
type Labels = typeof import("../../work-items/labels.js");
type Change = typeof import("../work-item-label-change.js");
let store: Store;
let labels: Labels;
let change: Change;

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  change = await import("../work-item-label-change.js");
});

function error(body: unknown): string {
  const parsed = change.parseLabelChange(body);
  if (!("error" in parsed)) throw new Error(`expected a refusal, got mode ${parsed.mode}`);
  return parsed.error;
}

describe("parseLabelChange", () => {
  it("reads each mode and trims the refs", () => {
    expect(change.parseLabelChange({ labels: [" bug ", "perf"] })).toEqual({ mode: "replace", refs: ["bug", "perf"] });
    expect(change.parseLabelChange({ add: ["  build  "] })).toEqual({ mode: "add", refs: ["build"] });
    expect(change.parseLabelChange({ remove: ["build"] })).toEqual({ mode: "remove", refs: ["build"] });
    expect(change.parseLabelChange({ labels: [] })).toEqual({ mode: "replace", refs: [] }); // a deliberate clear
  });

  it("refuses a body that names no mode, more than one, or an unusable ref", () => {
    expect(error({})).toContain("exactly one of labels");
    expect(error({ labels: ["bug"], remove: ["perf"] })).toContain("labels and remove were sent together");
    expect(error("labels=bug")).toBe("request body must be a JSON object");
    expect(error({ add: "build" })).toContain("add must be an array");
    expect(error({ add: ["  "] })).toContain("add must be an array");
    expect(error({ add: [] })).toContain("an empty add would change nothing");
    expect(error({ labels: Array.from({ length: 101 }, (_, i) => `l${i}`) }))
      .toContain(`labels accepts at most ${labels.TODO_LABELS_MAX} entries`);
  });
});

describe("applyLabelChange", () => {
  it("routes each mode to the write it names", () => {
    for (const name of ["route-build", "route-urgent"]) labels.createLabel({ name });
    const item = store.createWorkItem({ title: "labelled through the route" });

    change.applyLabelChange(item.id, { mode: "replace", refs: ["route-build", "route-urgent"] }, "operator");
    expect(change.applyLabelChange(item.id, { mode: "remove", refs: ["route-urgent"] }, "operator")
      .map((label) => label.name)).toEqual(["route-build"]);
    expect(change.applyLabelChange(item.id, { mode: "add", refs: ["route-urgent"] }, "operator")
      .map((label) => label.name)).toEqual(["route-build", "route-urgent"]);
  });
});
