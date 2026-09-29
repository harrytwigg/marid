import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry } from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowNode } from "../../workflows/model.js";
import type { WorkflowSessionExecutor } from "../../workflows/session-executor.js";

// Throwaway registry DB (SESSIONS_DB resolves from JINN_HOME at module load) —
// set BEFORE importing anything that touches the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wf-todo-gate-"));
process.env.JINN_HOME = tmp;

// Loaded AFTER the override, never as a static import: these reach
// shared/paths.ts, which freezes SESSIONS_DB at import time. A hoisted static
// import would resolve the path before this file set JINN_HOME, leaving both
// this file and todo-recovery.test.ts on the suite's one registry.db and racing
// into "database is locked".
const { openWorkflowDatabase } = await import("../../workflows/repository-migrations.js");
const { WorkflowRepository } = await import("../../workflows/repository.js");
const { WorkflowService } = await import("../../workflows/service.js");

type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Comments = typeof import("../../work-items/comments.js");
type Surface = typeof import("../workflow-todo-surface.js");
let store: Store;
let approvals: Approvals;
let comments: Comments;
let surface: Surface;

/* The two-door problem. A gate mirrored onto a Todo can be decided from either
 * side, and until now only one side settled the mirrored row: a Workflow-side
 * decision left the Todo's approval `pending` forever, which withholds the
 * reconciler's trust auto-close and shows the operator a decision that was
 * already made. Both doors now settle it, and the Todo door still settles it
 * exactly once — the mirror-back must not re-enter the decision it came from. */

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete the task.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

let seq = 0;

/** A Todo carrying the gate a run mirrored onto it, exactly as the run left it. */
function parkedOnGate(opts: { options?: string[]; nodeId?: string; ref?: string } = {}) {
  seq += 1;
  const runId = `run_${seq}`;
  const nodeId = opts.nodeId ?? "variant";
  const item = store.createWorkItem({ title: `Ship ${seq}`, status: "in_review", source: "human" });
  approvals.requestApproval(item.id, {
    request: "Which variant ships?",
    ref: opts.ref ?? `workflow:ship:${runId}:${nodeId}`,
    ...(opts.options ? { options: opts.options } : {}),
    actor: "workflow",
  });
  return { id: item.id, runId, nodeId };
}

/** What the runner hands the Todo surface once a gate is decided on the run. */
function decideOnTheRun(todoId: string, runId: string, nodeId: string,
  extra: { decision?: "approve" | "reject"; choice?: string; note?: string; decidedBy?: string } = {}) {
  surface.workflowTodoLifecycle.recordApprovalDecision({
    todoId, workflowId: "ship", runId, nodeId,
    decision: extra.decision ?? "approve", decidedBy: extra.decidedBy ?? "operator",
    ...(extra.choice === undefined ? {} : { choice: extra.choice }),
    ...(extra.note === undefined ? {} : { note: extra.note }),
  });
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  comments = await import("../../work-items/comments.js");
  surface = await import("../workflow-todo-surface.js");
});

beforeEach(() => { approvals.setTodoApprovalDecisionListener(null); });

describe("a gate decided on the run settles the Todo it was mirrored onto", () => {
  it("leaves the mirrored approval decided, carrying the same decision, pick and note", () => {
    const { id, runId, nodeId } = parkedOnGate({ options: ["variant-a", "variant-b"] });
    expect(approvals.currentApproval(id)!.state).toBe("pending");

    decideOnTheRun(id, runId, nodeId, { choice: "variant-b", note: "Cheapest to maintain.", decidedBy: "reviewer" });

    expect(approvals.currentApproval(id)).toMatchObject({
      state: "approved", choice: "variant-b", note: "Cheapest to maintain.", decidedBy: "reviewer",
    });
  });

  it("settles a rejection the same way", () => {
    const { id, runId, nodeId } = parkedOnGate();
    decideOnTheRun(id, runId, nodeId, { decision: "reject", note: "The empty state still reads as an error." });

    expect(approvals.currentApproval(id)).toMatchObject({
      state: "rejected", note: "The empty state still reads as an error.",
    });
  });

  it("still writes the gate note it always wrote", () => {
    const { id, runId, nodeId } = parkedOnGate({ options: ["variant-a", "variant-b"] });
    decideOnTheRun(id, runId, nodeId, { choice: "variant-a" });

    expect(comments.commentsTail(id).comments.at(-1)?.body).toBe(
      `**Workflow gate approved** by \`operator\`.\n\nPicked option: \`variant-a\`.\n\n`
      + `\`ship\` run \`${runId}\` · gate \`${nodeId}\`.`,
    );
  });

  it("does NOT re-enter the decision listener the run itself came through", () => {
    const seen: string[] = [];
    approvals.setTodoApprovalDecisionListener(({ decision }) => { seen.push(decision); });
    const { id, runId, nodeId } = parkedOnGate();

    decideOnTheRun(id, runId, nodeId);

    expect(seen).toEqual([]);
    expect(approvals.currentApproval(id)!.state).toBe("approved");
  });

  it("leaves a pending approval that belongs to some other gate alone", () => {
    const { id, runId } = parkedOnGate({ nodeId: "land" });
    decideOnTheRun(id, runId, "variant");

    expect(approvals.currentApproval(id)!.state).toBe("pending");
  });

  it("leaves a native Todo review approval alone", () => {
    const { id, runId, nodeId } = parkedOnGate({ ref: "review:manual" });
    decideOnTheRun(id, runId, nodeId);

    expect(approvals.currentApproval(id)!.state).toBe("pending");
  });
});

describe("the Todo door still settles exactly once", () => {
  it("records one decision and does not decide again when the run mirrors it back", async () => {
    const seen: string[] = [];
    approvals.setTodoApprovalDecisionListener(({ decision }) => { seen.push(decision); });
    const { id, runId, nodeId } = parkedOnGate({ options: ["variant-a", "variant-b"] });

    const result = await approvals.decideWorkItemApproval({
      id, decision: "approve", decidedBy: "operator", choice: "variant-a", note: "Ship it.",
    });
    expect(result.ok).toBe(true);
    const settled = approvals.currentApproval(id)!;

    // What the runner does next, on the very decision that woke it.
    decideOnTheRun(id, runId, nodeId, { choice: "variant-a", note: "Ship it." });

    expect(approvals.currentApproval(id)).toEqual(settled);
    expect(seen).toEqual(["approve"]);
  });
});

/* The whole loop, through the real service: a Todo-bound run parked on a choice
 * gate, decided from the Workflow side. */
describe("deciding a bound run's gate from the Workflow side", () => {
  function idleExecutor(): WorkflowSessionExecutor {
    return {
      async startAttempt() { return { sessionId: "unused" }; },
      async stopAttempt() {},
      subscribe() { return () => {}; },
      readTerminalCompletion() { return null; },
    } as unknown as WorkflowSessionExecutor;
  }

  function edge(id: string, from: string, port: string, to: string) {
    return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
  }

  // Padded labels are legal in a definition and the Todo mirror trims what it
  // stores, so a gate whose labels are not normalized at the source offers one
  // spelling on the run and another on the Todo — and the row stays pending on a
  // run that already completed.
  it.each([
    { labels: "plain", offered: ["variant-a", "variant-b"] },
    { labels: "padded", offered: [" variant-a ", " variant-b "] },
  ])("settles the mirrored Todo row and advances the run ($labels labels)", async ({ labels, offered }) => {
    const database = openWorkflowDatabase(path.join(tmp, `workflows-${labels}.db`));
    const repository = new WorkflowRepository(database);
    const service = new WorkflowService({
      repository, executor: idleExecutor(),
      employees: () => new Map([[employee.name, employee]]), models: () => models,
      todoApprovals: surface.workflowTodoApprovals(({ todoId, request, ref, options }) => {
        approvals.requestApproval(todoId, { request, ref, ...(options ? { options } : {}), actor: "workflow" });
      }),
      todoLifecycle: surface.workflowTodoLifecycle,
    });
    const created = repository.createDefinition({ id: `ship-variant-${labels}`, title: "Ship variant" });
    const definition: WorkflowDefinition = repository.saveDefinition({
      ...created, inputs: [],
      nodes: [
        { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
        { id: "variant", type: "approval", name: "Variant",
          config: { description: "Which variant ships?", options: offered } } as WorkflowNode,
        { id: "shipped", type: "end", name: "Shipped", config: { result: "success" } },
        { id: "dropped", type: "end", name: "Dropped", config: { result: "success" } },
      ],
      edges: [
        edge("start-variant", "start", "success", "variant"),
        edge("variant-approved", "variant", "approved", "shipped"),
        edge("variant-rejected", "variant", "rejected", "dropped"),
      ],
    }, created.revision);
    repository.setEnabled(definition.id, true, definition.revision);

    const todoId = store.createWorkItem({ title: "Pick the variant", status: "assigned", source: "human" }).id;
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });
    expect(run.status).toBe("waiting");
    expect(approvals.currentApproval(todoId)!.state).toBe("pending");
    expect(approvals.currentApproval(todoId)!.options).toEqual(["variant-a", "variant-b"]);

    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "variant",
      decision: "approve", decidedBy: "operator", choice: "variant-b", reason: "Fewer moving parts.",
      expectedRevision: run.revision });

    expect(decided.status).toBe("completed");
    expect(approvals.currentApproval(todoId)).toMatchObject({
      state: "approved", choice: "variant-b", note: "Fewer moving parts.", decidedBy: "operator",
    });

    service.dispose();
    database.close();
  });
});
