import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { TriggerNode, WorkflowDefinition, WorkflowNode } from "../../workflows/model.js";
import type { WorkflowRepository } from "../../workflows/repository.js";
import type { WorkflowRunner } from "../../workflows/runner.js";
import type { WorkflowTodoEventClaimOutcome } from "../../work-items/workflow-event-feed.js";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-settled-supersession-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

/* Supersession has to hold across drains, not just within one.
 *
 * A deferred event is one waiting for its label; when the label lands it re-enters
 * the supersession gate on the next drain, as a fresh arrival would. The gate built
 * its picture of "is there a newer event?" from the pending list alone — and that
 * list holds only UNSETTLED rows, only the newest page of them. So a sibling that
 * had already run was invisible, and the released deferral started a second run on
 * a lane a newer event had already taken.
 *
 * Both cases below are that hole: the newer event is out of the pending list once
 * because it settled, and once because the page ran out.
 */

type Store = typeof import("../../work-items/store.js");
type Labels = typeof import("../../work-items/labels.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Claims = typeof import("../../work-items/claims.js");
type Feed = typeof import("../../work-items/workflow-event-feed.js");
type Triggers = typeof import("../../workflows/trigger-service.js");
let store: Store;
let labels: Labels;
let transitions: Transitions;
let claims: Claims;
let feed: Feed;
let triggers: Triggers;

const definitions: WorkflowDefinition[] = [];
const started: Array<{ workflowId: string; todoId: string | undefined }> = [];
/** Every run these stubs start stays in flight. The Todo-wide claim now
 *  outlives a run only while one is still going, and what is under
 *  test here is that claim deciding a burst, not runs settling. */
const live: Array<{ id: string; idempotencyKey: string; status: "running" }> = [];

const repository = {
  listDefinitions: () => ({ items: definitions.map((item) => ({ id: item.id })), nextCursor: null }),
  getDefinition: (id: string) => definitions.find((item) => item.id === id),
  createRun: ({ workflowId, idempotencyKey, trigger }: { workflowId: string; idempotencyKey: string; trigger: { todoId?: string } }) => {
    started.push({ workflowId, todoId: trigger.todoId });
    live.push({ id: `run-${started.length}`, idempotencyKey, status: "running" });
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
  listRecoverableRuns: () => [...live],
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

function arm(id: string, config: Omit<Extract<TriggerNode["config"], { kind: "todo-status" }>, "kind">): void {
  const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", ...config } };
  definitions.push({ id, title: id, revision: 1, enabled: true, nodes: [trigger], edges: [] } as unknown as WorkflowDefinition);
}

/** One pass of the drain the gateway kicks off a status write or a label write. */
async function drain(): Promise<void> {
  const service = new triggers.WorkflowTriggerService(repository, runner, () => "now");
  await service.recoverTodoEvents();
  service.dispose();
}

function startsFor(workflowId: string): number {
  return started.filter((run) => run.workflowId === workflowId).length;
}

/** What the feed durably recorded against one event. */
function outcomesOf(eventId: string): WorkflowTodoEventClaimOutcome[] {
  const row = dbModule.initDb()
    .prepare("SELECT outcomes FROM workflow_todo_event_claims WHERE event_id = ?")
    .get(eventId) as { outcomes: string | null } | undefined;
  return JSON.parse(row?.outcomes ?? "[]") as WorkflowTodoEventClaimOutcome[];
}

/** Whether the feed has sealed an event, or still owes it a decision. */
function claimStateOf(eventId: string): string | undefined {
  const row = dbModule.initDb()
    .prepare("SELECT state FROM workflow_todo_event_claims WHERE event_id = ?")
    .get(eventId) as { state: string } | undefined;
  return row?.state;
}

function statusEvents(workItemId: string): Array<{ id: string }> {
  return store.listWorkItemEvents(workItemId).filter((entry) => entry.kind === "status_change");
}

/** A Todo moved to its arming status with no label, so its event defers. */
function armedOnceUnlabelled(title: string): { todoId: string; older: string } {
  const item = store.createWorkItem({ title, source: "human" });
  transitions.transition(item.id, "assigned", "operator", { human: true });
  return { todoId: item.id, older: statusEvents(item.id).at(-1)!.id };
}

/** The second arming move, once the first has had its drain. */
function armAgain(todoId: string): string {
  transitions.transition(todoId, "blocked", "operator", { human: true });
  transitions.transition(todoId, "assigned", "operator", { human: true });
  return statusEvents(todoId).at(-1)!.id;
}

/** Status rows on an unrelated Todo, to push older events off the pending page.
 *  `executing`/`in_review` is a legal cycle that no lane here is armed on, so the
 *  drain seals each one instead of leaving it pending. */
function noise(count: number): void {
  const filler = store.createWorkItem({ title: "a busy gateway's other work", source: "human" });
  transitions.transition(filler.id, "executing", "operator", { human: true });
  for (let index = 0; index < count; index += 1) {
    transitions.transition(filler.id, index % 2 === 0 ? "in_review" : "executing", "operator", { human: true });
  }
}

/** The winning run reaching its end: it lets the Todo go, so nothing but the
 *  supersession gate stands between a stale event and a second run on the lane. */
function winningRunFinishes(todoId: string, winner: string): void {
  expect(claims.releaseWorkItemClaim(todoId, `workflow:${winner}`)).toBe(true);
}

function supersededBy(older: string, newer: string, todoId: string, workflowId: string): WorkflowTodoEventClaimOutcome {
  return {
    workflowId,
    outcome: "deferred-then-superseded",
    detail: `Todo event ${older} waited for its label, then was superseded by ${newer},`
      + ` a newer assigned event on ${todoId}.`,
  };
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  transitions = await import("../../work-items/transitions.js");
  claims = await import("../../work-items/claims.js");
  feed = await import("../../work-items/workflow-event-feed.js");
  triggers = await import("../../workflows/trigger-service.js");
  dbModule.initDb();
});

beforeEach(() => { definitions.length = 0; started.length = 0; live.length = 0; });

describe("a released deferral loses to a newer event that has already run", () => {
  it("stands down when the winner settled in a drain that never saw this event", async () => {
    arm("settled-lane", { status: "assigned", label: "settled-build" });
    labels.createLabel({ name: "settled-build" });
    const { todoId, older } = armedOnceUnlabelled("beaten while it waited");
    await drain();
    const newer = armAgain(todoId);

    // A second gateway is mid-drain on the older event. Its lease is live, so this
    // drain cannot claim it and settles the newer event on its own.
    const elsewhere = feed.createWorkflowTodoEventFeed({ ownerId: "gateway-two" });
    expect(elsewhere.claimEvent(older, ["settled-lane"])).toMatchObject({ state: "acquired", deferred: true });
    labels.addWorkItemLabels(todoId, ["settled-build"], "operator");
    await drain();
    expect(startsFor("settled-lane")).toBe(1);
    expect(started.at(-1)!.todoId).toBe(todoId);

    // It hands the older event back deferred, exactly as the pass that read it
    // unlabelled had left it. The lane is taken, so nothing more may start on it.
    winningRunFinishes(todoId, newer);
    elsewhere.deferEvent(older, ["settled-lane"], []);
    await drain();

    expect(startsFor("settled-lane")).toBe(1);
    expect(outcomesOf(older)).toEqual([supersededBy(older, newer, todoId, "settled-lane")]);
  });

  it("stands down when the winner is past the pending page a busy gateway fills", async () => {
    arm("paged-lane", { status: "assigned", label: "paged-build" });
    labels.createLabel({ name: "paged-build" });
    const { todoId, older } = armedOnceUnlabelled("beaten behind a full page");
    await drain();

    // 520 rows land between the two arming moves, so the newest-500 page the drain
    // reads starts after the older event: only the newer one is on it.
    noise(520);
    const newer = armAgain(todoId);
    labels.addWorkItemLabels(todoId, ["paged-build"], "operator");
    await drain();
    expect(startsFor("paged-lane")).toBe(1);
    // The older event was off the page, so that drain never decided it.
    expect(claimStateOf(older)).toBe("processing");

    // The page has drained, so the older event is finally visible again — and by
    // then its winner is settled and off the pending list entirely.
    winningRunFinishes(todoId, newer);
    await drain();

    expect(startsFor("paged-lane")).toBe(1);
    expect(outcomesOf(older)).toEqual([supersededBy(older, newer, todoId, "paged-lane")]);
  }, 60_000);
});
