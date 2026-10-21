import { beforeAll, describe, expect, it } from "vitest";
import { startParentReviewHarness, treeInReview } from "../../gateway/__tests__/review-addressee-harness.js";

let workItems: Awaited<ReturnType<typeof startParentReviewHarness>>["workItems"];
let reviewAddressee: typeof import("../review-addressee.js").reviewAddressee;
let transition: typeof import("../transitions.js").transition;
let refreshOrg: Awaited<ReturnType<typeof startParentReviewHarness>>["refreshOrg"];
let context: typeof import("../../gateway/__tests__/review-addressee-harness.js").context;

beforeAll(async () => {
  ({ workItems, refreshOrg } = await startParentReviewHarness());
  ({ context } = await import("../../gateway/__tests__/review-addressee-harness.js"));
  ({ reviewAddressee } = await import("../review-addressee.js"));
  ({ transition } = await import("../transitions.js"));
});

const employee = (name: string) => ({ kind: "employee", employee: name });

describe("reviewAddressee", () => {
  it("is the operator for a Todo with no parent", () => {
    const root = workItems.createWorkItem({ title: "Root", status: "in_review", assignee: "owner-dev" });
    expect(reviewAddressee(root)).toEqual({ kind: "operator" });
  });

  it.each([
    ["backlog", { kind: "operator" }],
    ["executing", employee("owner-dev")],
    ["blocked", employee("owner-dev")],
    ["in_review", { kind: "operator" }],
    ["done", { kind: "operator" }],
    ["cancelled", { kind: "operator" }],
  ] as const)("with the parent %s, is %j", (status, expected) => {
    const { parent, child } = treeInReview(workItems, `Parent ${status}`);
    if (status === "blocked") transition(parent.id, "blocked", "operator", { human: true, blockKind: "needs_input" });
    else if (status === "backlog") transition(parent.id, "backlog", "operator", { human: true });
    else if (status === "in_review") transition(parent.id, "in_review", "operator", { detail: { note: "ready" } });
    else if (status === "done" || status === "cancelled") {
      transition(child.id, status, "operator", { human: true });
      transition(parent.id, status, "operator", { human: true });
    }
    expect(reviewAddressee(workItems.getWorkItem(child.id)!)).toEqual(expected);
  });

  it("is the operator when the operator owns the parent, or nobody does", () => {
    const { child } = treeInReview(workItems, "Operator parent", { parentOwner: "@operator" });
    expect(reviewAddressee(child)).toEqual({ kind: "operator" });
    const orphanParent = workItems.createWorkItem({ title: "Unassigned parent", status: "executing" });
    const under = workItems.createWorkItem({ title: "Child of unassigned", status: "in_review", parentId: orphanParent.id });
    expect(reviewAddressee(under)).toEqual({ kind: "operator" });
  });

  it("is the operator when the parent's assignee is no longer in the org", () => {
    const { child } = treeInReview(workItems, "Departed owner", { parentOwner: "gone-dev" });
    expect(reviewAddressee(child)).toEqual({ kind: "operator" });
  });

  it("is the operator once the parent is closed", () => {
    const { parent, child } = treeInReview(workItems, "Closed parent");
    transition(child.id, "done", "operator", { human: true });
    transition(parent.id, "done", "operator", { human: true });
    expect(reviewAddressee(workItems.getWorkItem(child.id)!)).toEqual({ kind: "operator" });
    const { parent: cancelledParent, child: other } = treeInReview(workItems, "Cancelled parent");
    transition(other.id, "cancelled", "operator", { human: true });
    transition(cancelledParent.id, "cancelled", "operator", { human: true });
    expect(reviewAddressee(workItems.getWorkItem(other.id)!)).toEqual({ kind: "operator" });
  });

  it("follows a reassigned parent on the next read, and is never stored", async () => {
    const { parent, child } = treeInReview(workItems, "Reassigned parent");
    expect(reviewAddressee(child)).toEqual(employee("owner-dev"));

    const { assignWorkItem } = await import("../assignment.js");
    assignWorkItem(parent.id, "third-dev", "engineering", "operator");
    expect(reviewAddressee(workItems.getWorkItem(child.id)!)).toEqual(employee("third-dev"));

    assignWorkItem(parent.id, "@operator", null, "operator");
    expect(reviewAddressee(workItems.getWorkItem(child.id)!)).toEqual({ kind: "operator" });
    expect(Object.keys(workItems.getWorkItem(child.id)!)).not.toContain("reviewAddressee");
  });

  it("reads the live org: a removed employee stops being an addressee", async () => {
    const { child } = treeInReview(workItems, "Org change");
    expect(reviewAddressee(child)).toEqual(employee("owner-dev"));
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { home } = await import("../../gateway/__tests__/review-addressee-harness.js");
    const file = path.join(home, "org", "engineering", "owner-dev.yaml");
    const saved = fs.readFileSync(file, "utf-8");
    try {
      fs.rmSync(file);
      refreshOrg(context.getConfig());
      expect(reviewAddressee(child)).toEqual({ kind: "operator" });
    } finally {
      fs.writeFileSync(file, saved);
      refreshOrg(context.getConfig());
    }
    expect(reviewAddressee(child)).toEqual(employee("owner-dev"));
  });
});
