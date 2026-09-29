import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-claim-trigger-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Claims = typeof import("../../work-items/claims.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let claims: Claims;
let triggers: Triggers;

const trigger: WorkflowNode = {
  id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review" },
};
const definition = {
  id: "claim-flow", title: "Claim flow", revision: 1, enabled: true, nodes: [trigger], edges: [],
} as unknown as WorkflowDefinition;

const started: string[] = [];
/** Who held the Todo at the instant the run was created — the only place the
 *  ordering is observable, because after the fire both orders look alike. */
const heldWhenRunCreated: (string | null)[] = [];
/** The runs still going, as the repository would list them: a started run lands
 *  here `running` unless a test settles it, and leaves when it settles. */
const live: Array<{ id: string; idempotencyKey: string; status: "running" }> = [];
/** What `runner.start` hands back — `running` for work in flight, `completed`
 *  for a run that settled inside its own start, the way a skip End does. */
let startOutcome: "running" | "completed" = "running";

const repository = {
  listDefinitions: () => ({ items: [{ id: definition.id }], nextCursor: null }),
  getDefinition: () => definition,
  createRun: ({ idempotencyKey, trigger }: { idempotencyKey: string; trigger: { todoId?: string } }) => {
    started.push(idempotencyKey);
    heldWhenRunCreated.push(claims.getWorkItemClaim(trigger.todoId ?? "")?.owner ?? null);
    const id = `run-${started.length}`;
    if (startOutcome === "running") live.push({ id, idempotencyKey, status: "running" });
    return { id };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "pending" }),
  listRecoverableRuns: () => [...live],
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: startOutcome }) } as unknown as WorkflowRunner;

function settled(runId: string, fireId: string, workItemId: string, status: "completed" | "failed" | "cancelled" = "completed") {
  const index = live.findIndex((run) => run.id === runId);
  if (index >= 0) live.splice(index, 1);
  return { status, trigger: { nodeId: "start", kind: "todo-status" as const, fireId, payload: {}, todoId: workItemId } };
}

/** Every event is fresh to the feed, so the only thing that can suppress the
 *  second fire is the Todo claim rather than the event claim. */
const feed: WorkflowTodoEventFeed = {
  claimEvent: (_id, definitionIds) => ({ state: "acquired", definitionIds }),
  completeEvent: (_id: string, _outcomes: WorkflowTodoEventClaimOutcome[]) => {},
  deferEvent: (_id: string, _definitionIds: string[], _outcomes: WorkflowTodoEventClaimOutcome[]) => {},
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

let pending: WorkflowTodoStatusEvent[] = [];

function event(id: string, workItemId: string): WorkflowTodoStatusEvent {
  return {
    id, workItemId, fromStatus: "executing", toStatus: "in_review", actor: "operator", actorEmployee: null, armedAsDelegate: null,
    quotaWindowDecided: false,
    item: { source: "human", department: null, assignee: null, labels: [], autoStart: true,
      live: { assignee: null, parentId: null, status: "in_review" } },
  };
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  claims = await import("../../work-items/claims.js");
  triggers = await import("../trigger-service.js");
});

beforeEach(() => { started.length = 0; heldWhenRunCreated.length = 0; live.length = 0; pending = []; startOutcome = "running"; });

describe("the todo-status trigger and the Todo claim", () => {
  it("claims the Todo before starting a run", async () => {
    const item = store.createWorkItem({ title: "ready for review" });
    pending = [event("event-1", item.id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-1"]);
    expect(heldWhenRunCreated).toEqual(["workflow:event-1"]);
  });

  it("starts no second run for another event on a Todo it is already working", async () => {
    const item = store.createWorkItem({ title: "moved twice" });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    pending = [event("event-2", item.id)];
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-1"]);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-1");
  });

  it("still fires for a Todo whose row is gone, which nothing can double-work", async () => {
    pending = [event("event-3", "ICI-999999")];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-3"]);
  });
});

describe("handing the Todo back when the workflow holds nothing on it", () => {
  it("releases the claim when the run settled inside its own start, as a skip End does", async () => {
    const item = store.createWorkItem({ title: "opted out" });
    pending = [event("event-1", item.id)];
    startOutcome = "completed";

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-1"]);
    expect(heldWhenRunCreated).toEqual(["workflow:event-1"]);
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    // The whole point: a manual Dispatch straight afterwards is not refused.
    expect(claims.claimWorkItem({ workItemId: item.id, owner: "dispatch:by-hand" }).state).toBe("acquired");
  });

  it("keeps the claim while the run is going and releases it when the run settles", async () => {
    const item = store.createWorkItem({ title: "worked by a run" });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-1");
    expect(claims.claimWorkItem({ workItemId: item.id, owner: "dispatch:by-hand" }).state).toBe("held");

    service.runSettled(settled("run-1", "event-1", item.id));

    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    expect(claims.claimWorkItem({ workItemId: item.id, owner: "dispatch:by-hand" }).state).toBe("acquired");
  });

  it.each(["failed", "cancelled"] as const)("releases the claim on a run that settled %s", async (status) => {
    const item = store.createWorkItem({ title: `settled ${status}` });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    service.runSettled(settled("run-1", "event-1", item.id, status));

    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
  });

  it("ignores a run that is still going, and one that is not a Todo's", async () => {
    const item = store.createWorkItem({ title: "not settled" });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    service.runSettled({ status: "running", trigger: { nodeId: "start", kind: "todo-status", fireId: "event-1", payload: {}, todoId: item.id } });
    service.runSettled({ status: "completed", trigger: { nodeId: "start", kind: "schedule", fireId: "event-1", payload: {} } });

    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-1");
  });

  it("never lets go of a claim that has since passed to somebody else", async () => {
    const item = store.createWorkItem({ title: "taken over" });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();
    // The lease ran out and a manual Dispatch took the Todo; the run settling
    // late must not unlock the Dispatcher's work.
    claims.releaseWorkItemClaim(item.id, "workflow:event-1");
    expect(claims.claimWorkItem({ workItemId: item.id, owner: "dispatch:by-hand" }).state).toBe("acquired");

    service.runSettled(settled("run-1", "event-1", item.id));

    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("dispatch:by-hand");
  });
});

describe("one event starting a run per definition", () => {
  const second = { ...definition, id: "claim-flow-2", title: "Claim flow 2" } as unknown as WorkflowDefinition;
  const both = {
    ...repository,
    listDefinitions: () => ({ items: [{ id: definition.id }, { id: second.id }], nextCursor: null }),
    getDefinition: (id: string) => (id === second.id ? second : definition),
  } as unknown as WorkflowRepository;

  it("holds the Todo until the last of the runs has settled", async () => {
    const item = store.createWorkItem({ title: "two definitions" });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(both, runner, () => "now", feed);
    await service.recoverTodoEvents();
    expect(started).toEqual(["todo:event-1", "todo:event-1"]);

    service.runSettled(settled("run-1", "event-1", item.id));
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-1");

    service.runSettled(settled("run-2", "event-1", item.id));
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
  });

  it("does not let a run that settles at start release the Todo before its sibling has been created", async () => {
    const item = store.createWorkItem({ title: "first one skips" });
    pending = [event("event-1", item.id)];
    let service: InstanceType<Triggers["WorkflowTriggerService"]>;
    // The first definition's run routes straight to an End inside `start`, and the
    // change hook reports it settled while the second definition's run is still
    // to be created on the same claim.
    const skipsFirst = { start: async (runId: string) => {
      if (runId === "run-1") { service.runSettled(settled(runId, "event-1", item.id)); return { id: runId, status: "completed" }; }
      return { id: runId, status: "running" };
    } } as unknown as WorkflowRunner;
    service = new triggers.WorkflowTriggerService(both, skipsFirst, () => "now", feed);
    await service.recoverTodoEvents();

    expect(heldWhenRunCreated).toEqual(["workflow:event-1", "workflow:event-1"]);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-1");

    service.runSettled(settled("run-2", "event-1", item.id));
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
  });
});
