import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { TriggerNode, WorkflowDefinition, WorkflowNode } from "../../workflows/model.js";
import type { WorkflowRepository } from "../../workflows/repository.js";
import type { WorkflowRunner } from "../../workflows/runner.js";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-label-rearm-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

/* The label half of arming a lane, end to end against the real store and the real
 * event feed. Two ways a correctly-labelled Todo used to end up sitting at its
 * arming status with nothing armed and nothing that would ever look again:
 *
 *   - a phase stripped the arming label mid-run, and the re-arm could not put it
 *     back because it never carried the trigger's label filter;
 *   - the label landed a moment AFTER the status move, so the drain — which the
 *     status write itself kicks — judged the Todo unlabelled and sealed the event.
 */

type Store = typeof import("../../work-items/store.js");
type Labels = typeof import("../../work-items/labels.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Comments = typeof import("../../work-items/comments.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Surface = typeof import("../workflow-todo-surface.js");
type Triggers = typeof import("../../workflows/trigger-service.js");
let store: Store;
let labels: Labels;
let approvals: Approvals;
let comments: Comments;
let transitions: Transitions;
let surface: Surface;
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

/** What the feed durably recorded for a Todo's newest status event. */
function claim(workItemId: string): { state: string; outcomes: string } {
  const event = store.listWorkItemEvents(workItemId).filter((entry) => entry.kind === "status_change").at(-1)!;
  return dbModule.initDb()
    .prepare("SELECT state, outcomes FROM workflow_todo_event_claims WHERE event_id = ?")
    .get(event.id) as { state: string; outcomes: string };
}

/** A Todo parked in review on a rejected run-bound gate, as a handback leaves it. */
async function handedBack(title: string, runId: string) {
  const item = store.createWorkItem({ title, status: "in_review", source: "human" });
  approvals.requestApproval(item.id, { request: "Merge?", ref: `workflow:build-lane:${runId}:gate` });
  const decided = await approvals.decideWorkItemApproval({
    id: item.id, decision: "reject", note: "Not yet — the empty state still reads as an error.", decidedBy: "operator",
  });
  expect(decided.ok).toBe(true);
  return item;
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  approvals = await import("../../work-items/approvals.js");
  comments = await import("../../work-items/comments.js");
  transitions = await import("../../work-items/transitions.js");
  surface = await import("../workflow-todo-surface.js");
  triggers = await import("../../workflows/trigger-service.js");
  dbModule.initDb();
});

beforeEach(() => { definitions.length = 0; started.length = 0; live.length = 0; });

describe("a handback re-arms into the trigger it is arming", () => {
  it("puts the arming label back before the move, so the re-armed Todo fires", async () => {
    arm("build-lane", { status: "assigned", label: "build" });
    labels.createLabel({ name: "build" });
    const item = await handedBack("stripped mid-run", "run_strip");
    labels.setWorkItemLabels(item.id, ["build"], "operator");
    // A phase disarmed the Todo while the run was working it. Nothing put it back.
    labels.removeWorkItemLabels(item.id, ["build"], "session:phase");
    expect(labels.getWorkItemLabels(item.id)).toEqual([]);

    surface.workflowTodoLifecycle.requestRevision({
      todoId: item.id, workflowId: "build-lane", runId: "run_strip", nodeId: "gate",
      feedback: "Not yet — the empty state still reads as an error.", decidedBy: "operator",
      rearm: { status: "assigned", label: "build" },
    });

    expect(store.getWorkItem(item.id)!.status).toBe("assigned");
    expect(labels.getWorkItemLabels(item.id).map((label) => label.name)).toEqual(["build"]);
    await drain();
    expect(startsFor("build-lane")).toBe(1);
    expect(started.at(-1)!.todoId).toBe(item.id);
  });

  it("stops the revision when the label filter cannot be satisfied, rather than parking the Todo", async () => {
    arm("ghost-lane", { status: "assigned", label: "never-registered" });
    const item = await handedBack("unsatisfiable filter", "run_ghost");

    surface.workflowTodoLifecycle.requestRevision({
      todoId: item.id, workflowId: "ghost-lane", runId: "run_ghost", nodeId: "gate",
      feedback: "Not yet — the empty state still reads as an error.", decidedBy: "operator",
      rearm: { status: "assigned", label: "never-registered" },
    });

    // Blocked and said out loud, never left at the arming status with no run.
    expect(store.getWorkItem(item.id)!.status).toBe("blocked");
    expect(store.isBlockDeclared(item.id)).toBe(true);
    const comment = comments.listComments(item.id).comments.at(-1)!.body;
    expect(comment).toContain("only fires for Todos labelled `never-registered`");
    expect(comment).toContain("could not be put back");
    await drain();
    expect(startsFor("ghost-lane")).toBe(0);
  });
});

describe("a label that lands after the status move", () => {
  it("arms the Todo when the label follows the move, instead of sealing the event unlabelled", async () => {
    arm("race-lane", { status: "assigned", label: "race-build" });
    labels.createLabel({ name: "race-build" });
    const item = store.createWorkItem({ title: "moved first, labelled second", source: "human" });
    transitions.transition(item.id, "assigned", "operator", { human: true });

    await drain();
    expect(startsFor("race-lane")).toBe(0);
    // Refused, recorded, and deliberately NOT sealed: the label can still land.
    expect(claim(item.id)).toMatchObject({ state: "processing" });
    expect(claim(item.id).outcomes).toContain("label filter race-build does not match");

    labels.addWorkItemLabels(item.id, ["race-build"], "operator");
    await drain();

    expect(startsFor("race-lane")).toBe(1);
    expect(claim(item.id)).toMatchObject({ state: "processed" });
  });

  it("matches the label filter against the label id as well as the normalized name", async () => {
    const byId = labels.createLabel({ name: "Race By Id" });
    arm("race-by-id", { status: "assigned", label: byId.id });
    const item = store.createWorkItem({ title: "labelled by id", source: "human" });
    labels.setWorkItemLabels(item.id, [byId.id], "operator");
    transitions.transition(item.id, "assigned", "operator", { human: true });

    await drain();
    expect(startsFor("race-by-id")).toBe(1);
  });

  it("stops reopening once the Todo has moved on from where the event put it", async () => {
    arm("stale-lane", { status: "assigned", label: "stale-build" });
    labels.createLabel({ name: "stale-build" });
    const item = store.createWorkItem({ title: "moved on", source: "human" });
    transitions.transition(item.id, "assigned", "operator", { human: true });
    await drain();
    const armingEvent = store.listWorkItemEvents(item.id).filter((entry) => entry.kind === "status_change").at(-1)!;

    transitions.transition(item.id, "executing", "operator", { human: true });
    labels.addWorkItemLabels(item.id, ["stale-build"], "operator");
    await drain();

    expect(startsFor("stale-lane")).toBe(0);
    const sealed = dbModule.initDb()
      .prepare("SELECT state FROM workflow_todo_event_claims WHERE event_id = ?")
      .get(armingEvent.id) as { state: string };
    expect(sealed.state).toBe("processed");
  });

  it("keeps the label-refused definition drainable even when another definition on the same status ran", async () => {
    arm("open-lane", { status: "assigned" });
    arm("gated-lane", { status: "assigned", label: "shared-build" });
    labels.createLabel({ name: "shared-build" });
    const item = store.createWorkItem({ title: "two lanes, one event", source: "human" });
    transitions.transition(item.id, "assigned", "operator", { human: true });

    await drain();
    expect(startsFor("open-lane")).toBe(1);
    expect(startsFor("gated-lane")).toBe(0);

    // One event, two definitions: closing it on the one that ran would seal the
    // other forever. Only the definitions the label refused go back in.
    labels.addWorkItemLabels(item.id, ["shared-build"], "operator");
    await drain();

    expect(startsFor("gated-lane")).toBe(1);
    // ...and the one that already ran does not run a second time.
    expect(startsFor("open-lane")).toBe(1);
  });

  it("seals a Todo a non-label filter ALSO refused, rather than reading it as a label race", async () => {
    arm("root-lane", { status: "assigned", label: "root-build", rootOnly: true });
    labels.createLabel({ name: "root-build" });
    const parent = store.createWorkItem({ title: "parent", source: "human" });
    const child = store.createWorkItem({ title: "child", source: "human", parentId: parent.id });
    transitions.transition(child.id, "assigned", "operator", { human: true });

    await drain();

    // The label is missing AND the Todo is a child. Being a child is a decision no
    // label can change, so the event is closed on it, naming that filter.
    expect(claim(child.id)).toMatchObject({ state: "processed" });
    expect(claim(child.id).outcomes).toContain("rootOnly filter does not match");
    labels.addWorkItemLabels(child.id, ["root-build"], "operator");
    await drain();
    expect(startsFor("root-lane")).toBe(0);
  });

  it("seals an event a filter OTHER than label refused, so satisfying that filter later fires nothing", async () => {
    arm("intake-lane", { status: "assigned", unlabeled: true });
    labels.createLabel({ name: "chore" });
    const item = store.createWorkItem({ title: "labelled at intake", source: "human" });
    labels.setWorkItemLabels(item.id, ["chore"], "operator");
    transitions.transition(item.id, "assigned", "operator", { human: true });

    await drain();
    expect(startsFor("intake-lane")).toBe(0);
    expect(claim(item.id)).toMatchObject({ state: "processed" });
    expect(claim(item.id).outcomes).toContain("unlabeled filter does not match");

    // `unlabeled` read the Todo and decided. Clearing the label does not reopen it.
    labels.removeWorkItemLabels(item.id, ["chore"], "operator");
    await drain();
    expect(startsFor("intake-lane")).toBe(0);
  });

  it("lets the newest of several waiting events win the lane when the label lands", async () => {
    arm("burst-open", { status: "assigned" });
    arm("burst-gated", { status: "assigned", label: "burst-build" });
    labels.createLabel({ name: "burst-build" });
    const item = store.createWorkItem({ title: "armed twice, labelled once", source: "human" });
    // Two arming moves with no drain between them, so both events are still
    // waiting when the label finally lands.
    transitions.transition(item.id, "assigned", "operator", { human: true });
    transitions.transition(item.id, "blocked", "operator", { human: true });
    transitions.transition(item.id, "assigned", "operator", { human: true });
    const [first, , second] = store.listWorkItemEvents(item.id).filter((entry) => entry.kind === "status_change");

    await drain();
    expect(startsFor("burst-gated")).toBe(0);

    labels.addWorkItemLabels(item.id, ["burst-build"], "operator");
    await drain();

    // Releasing a deferral re-enters the supersession gate, so the older event
    // never beats the newer one it had been waiting alongside.
    expect(startsFor("burst-gated")).toBe(1);
    const held = dbModule.initDb()
      .prepare("SELECT outcomes FROM workflow_todo_event_claims WHERE event_id = ?")
      .get(first!.id) as { outcomes: string };
    expect(JSON.parse(held.outcomes)).toEqual([{
      workflowId: "burst-gated",
      outcome: "deferred-then-superseded",
      detail: `Todo event ${first!.id} waited for its label, then was superseded by ${second!.id},`
        + ` a newer assigned event on ${item.id}.`,
    }]);
  });
});
