import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

const reconcile = await import("../../work-items/reconcile.js");
const runs = await import("../../work-items/runs.js");

/*went executing → in_review, actor `reconciler`, twenty seconds
 * after its producer's first run ended: no draft PR, QA in round one, a
 * question for the operator not yet asked. The reconciler read a clean run end
 * as the work being finished. `in_review` is the operator's desk, and only he
 * moves a Todo off it, so the producer could not undo it.
 *
 * A reviewed Todo now reaches review only when its producer says so. These
 * drive the real routes an agent's MCP tools call. */

async function call(method: string, urlPath: string, body: unknown, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, body, headers), cap.res, ctx);
  return cap;
}

/** A producer session linked to its Todo as the execution attempt, with the run
 *  the dispatcher opens for it's shape. */
function producerOn(title: string, sourceRef: string) {
  const item = store.createWorkItem({ title, status: "executing", source: "session", assignee: "platform-worker" });
  const producer = reg.createSession({ engine: "codex", source: "web", sourceRef, employee: "platform-worker" });
  store.linkSession(item.id, producer.id);
  runs.openWorkItemRun({ workItemId: item.id, sessionId: producer.id });
  reg.updateSession(producer.id, { status: "running" });
  return { item, producer };
}

/** The producer's run ending cleanly: a turn finished, not the work. */
function runEnds(sessionId: string): void {
  reg.updateSession(sessionId, { status: "idle", attemptOutcome: "succeeded", lastActivity: new Date().toISOString() });
}

const statusMoves = (id: string) =>
  store.listWorkItemEvents(id)
    .filter((event) => event.kind === "status_change")
    .map((event) => `${event.fromStatus}→${event.toStatus}:${event.actor}`);

describe("a producer's run ending never moves a reviewed Todo to in_review", () => {
  it("replays the run ends mid-work and the Todo stays executing across sweeps", () => {
    const { item, producer } = producerOn("Blog byline, half done", "sys2-replay");
    expect(reconcile.reconcileWorkItem(item.id)?.item.status).toBe("executing");

    runEnds(producer.id);
    reconcile.reconcileActiveWorkItems();
    reconcile.reconcileActiveWorkItems();

    expect(store.getWorkItem(item.id)?.status).toBe("executing");
    expect(statusMoves(item.id)).toEqual([]);
    // The ledger still records the run itself as finished; only the status holds.
    expect(runs.listWorkItemRuns(item.id)[0]).toMatchObject({ outcome: "completed" });
    expect(runs.listWorkItemRuns(item.id)[0].endedAt).not.toBeNull();
  });

  it("stays executing when a later run resumes the work and ends too", () => {
    const { item, producer } = producerOn("Resumed and paused again", "sys2-resume");
    runEnds(producer.id);
    reconcile.reconcileActiveWorkItems();

    reg.updateSession(producer.id, { status: "running", attemptOutcome: null, lastActivity: new Date().toISOString() });
    expect(reconcile.reconcileWorkItem(item.id)?.item.status).toBe("executing");
    runEnds(producer.id);
    reconcile.reconcileActiveWorkItems();

    expect(store.getWorkItem(item.id)?.status).toBe("executing");
    expect(statusMoves(item.id)).toEqual([]);
  });

  it("an approval requested mid-work is a question, not a hand-in: the Todo stays executing", async () => {
    const { item, producer } = producerOn("Needs a choice from the operator", "sys2-mid-work-approval");

    const asked = await call("POST", `/api/work-items/${item.id}/approval/request`, {
      request: "A or B?",
      options: ["A", "B"],
      operatorOnly: true,
    }, toolHeaders(producer.id));
    expect(asked.status).toBe(200);
    runEnds(producer.id);
    reconcile.reconcileActiveWorkItems();

    expect(store.getWorkItem(item.id)).toMatchObject({ status: "executing", approvalState: "pending" });
    expect(statusMoves(item.id)).toEqual([]);
  });

  it("still reaches in_review, and then done, when the producer hands it in explicitly", async () => {
    const { item, producer } = producerOn("Finished and QA'd", "sys2-normal-path");
    runEnds(producer.id);
    reconcile.reconcileActiveWorkItems();
    expect(store.getWorkItem(item.id)?.status).toBe("executing");

    // The documented hand-in: update_work_item → in_review, then request_work_item_approval.
    const handed = await call("POST", `/api/work-items/${item.id}/status`, {
      status: "in_review",
      note: "Draft PR open, QA passed.",
    }, toolHeaders(producer.id));
    expect([handed.status, handed.body.workItem?.status]).toEqual([200, "in_review"]);
    const asked = await call("POST", `/api/work-items/${item.id}/approval/request`, {
      request: "Finished: please review the draft PR.",
      operatorOnly: true,
    }, toolHeaders(producer.id));
    expect(asked.status).toBe(200);

    // A follow-up turn on the producer (answering a comment) does not pull it back.
    reg.updateSession(producer.id, { status: "running", attemptOutcome: null, lastActivity: new Date().toISOString() });
    reconcile.reconcileActiveWorkItems();
    runEnds(producer.id);
    reconcile.reconcileActiveWorkItems();
    expect(store.getWorkItem(item.id)).toMatchObject({ status: "in_review", approvalState: "pending" });

    const decided = await call("POST", `/api/work-items/${item.id}/approval`, { decision: "approve", note: "ship" }, operatorHeaders);
    expect(decided.status).toBe(200);
    expect(store.getWorkItem(item.id)?.status).toBe("done");
    expect(statusMoves(item.id)).toEqual([
      "executing→in_review:session:" + producer.id,
      "in_review→done:operator",
    ]);
  });
});
