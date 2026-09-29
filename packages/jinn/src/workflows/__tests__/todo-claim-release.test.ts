import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/**
 *end to end through the real runner: the claim a `todo-status`
 * trigger takes on its Todo is given back once every run it started has
 * settled — a run that only routes to a skip End, one that ran an employee to
 * completion, one that failed and one that was cancelled — so a manual
 * Dispatch straight afterwards is acquired rather than refused for the rest of
 * the lease.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-claim-release-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Claims = typeof import("../../work-items/claims.js");
let store: Store;
let claims: Claims;

const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };

class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): null { return null; }
  /** The session behind the last attempt reported its turn over. */
  async finish(outcome: "succeeded" | "failed", at: string): Promise<void> {
    const command = this.commands.at(-1)!;
    const event: WorkflowAttemptCompletion = { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`,
      owner: command.owner, turn: 1, terminalVersion: 1, completedAt: at, outcome,
      ...(outcome === "succeeded" ? { finalText: "Done.\n```jinn-output\n{}\n```" } : { error: "Interactive turn failed: server_error" }) };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

class TodoFeed implements WorkflowTodoEventFeed {
  readonly pending: WorkflowTodoStatusEvent[] = [];
  readonly processed = new Map<string, WorkflowTodoEventClaimOutcome[]>();
  claimEvent(id: string, definitionIds: string[]) {
    const prior = this.processed.get(id);
    return prior ? { state: "processed" as const, outcomes: prior } : { state: "acquired" as const, definitionIds };
  }
  completeEvent(id: string, outcomes: WorkflowTodoEventClaimOutcome[]): void { this.processed.set(id, outcomes); }
  deferEvent(id: string, _definitionIds: string[], outcomes: WorkflowTodoEventClaimOutcome[]): void { this.processed.set(id, outcomes); }
  releaseEvent(): void {}
  listPendingEvents(): WorkflowTodoStatusEvent[] { return this.pending.filter((event) => !this.processed.has(event.id)); }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let feed: TodoFeed;
let service: WorkflowService;
const now = "2026-09-18T11:00:00.000Z";

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}
/** The shape of `todo-auto-start`: a `todo-status` trigger, a Condition that
 *  sends an opted-out Todo straight to a skip End, and an Employee node
 *  otherwise. */
function saveAutoStart(): string {
  const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Assigned", config: { kind: "todo-status", status: "assigned" } };
  const check: WorkflowNode = { id: "check", type: "condition", name: "Should this start?", config: {
    cases: [{ port: "opted-out", label: "Labelled no-auto-start", all: [{
      left: { source: "trigger", path: "payload.labels" }, operator: "contains", right: { source: "fixed", value: "no-auto-start" } }] }],
    defaultPort: "go" } };
  const work: WorkflowNode = { id: "work", type: "employee", name: "Start work", config: {
    employee: { source: "fixed", value: "worker" }, prompt: "Do work.",
    retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" }, timeoutMinutes: 1 } };
  const notified: WorkflowNode = { id: "notified", type: "end", name: "Notified", config: { result: "success" } };
  const skipped: WorkflowNode = { id: "skipped", type: "end", name: "Skipped", config: { result: "success" } };
  const draft = service.createDefinition({ id: "auto-start", title: "Auto-start" });
  const saved = service.saveDefinition({ ...draft, nodes: [trigger, check, work, notified, skipped], edges: [
    edge("e1", "start", "success", "check"), edge("e2", "check", "go", "work"),
    edge("e3", "work", "success", "notified"), edge("e4", "check", "opted-out", "skipped"),
  ] }, draft.revision);
  service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
  return saved.id;
}
function assigned(id: string, workItemId: string, labels: string[] = []): WorkflowTodoStatusEvent {
  return { id, workItemId, fromStatus: "backlog", toStatus: "assigned", actor: "operator", actorEmployee: null, armedAsDelegate: null,
    quotaWindowDecided: false,
    item: { source: "human", department: null, assignee: "worker", autoStart: true,
      labels: labels.map((name) => ({ id: `lbl_${name}`, name })),
      live: { assignee: "worker", parentId: null, status: "assigned" } } };
}
/** What a click on Dispatch asks: the claim, under a fresh owner. */
function dispatchByHand(workItemId: string): string {
  return claims.claimWorkItem({ workItemId, owner: `dispatch:${workItemId}` }).state;
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  claims = await import("../../work-items/claims.js");
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-claim-release-db-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => now); executor = new Executor(); feed = new TodoFeed();
  service = new WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now, todoEventFeed: feed });
});
afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("the Todo claim a todo-status trigger takes", () => {
  it("is given back the moment a run routes to a skip End, so Dispatch is not refused for the lease", async () => {
    const workflowId = saveAutoStart();
    const item = store.createWorkItem({ title: "opted out of auto-start" });
    feed.pending.push(assigned("evt-skip", item.id, ["no-auto-start"]));

    await service.recover(now);

    const run = service.listRuns(workflowId, {}).items[0]!;
    expect(service.getRun(workflowId, run.id)).toMatchObject({ status: "completed", trigger: { todoId: item.id, fireId: "evt-skip" } });
    expect(service.getRun(workflowId, run.id)!.nodeRuns.find((node) => node.nodeId === "skipped")?.status).toBe("completed");
    expect(executor.commands).toHaveLength(0);
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    expect(dispatchByHand(item.id)).toBe("acquired");
  });

  it("is held for the whole life of a run that started an employee, and given back when it completes", async () => {
    const workflowId = saveAutoStart();
    const item = store.createWorkItem({ title: "auto-started" });
    feed.pending.push(assigned("evt-work", item.id));

    await service.recover(now);
    const run = service.listRuns(workflowId, {}).items[0]!;
    expect(service.getRun(workflowId, run.id)?.status).toBe("running");
    expect(executor.commands).toHaveLength(1);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:evt-work");
    expect(dispatchByHand(item.id)).toBe("held");

    await executor.finish("succeeded", now);

    expect(service.getRun(workflowId, run.id)?.status).toBe("completed");
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    expect(dispatchByHand(item.id)).toBe("acquired");
  });

  it("is given back when the run fails", async () => {
    const workflowId = saveAutoStart();
    const item = store.createWorkItem({ title: "attempt crashed" });
    feed.pending.push(assigned("evt-fail", item.id));
    await service.recover(now);
    const run = service.listRuns(workflowId, {}).items[0]!;
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:evt-fail");

    await executor.finish("failed", now);

    expect(service.getRun(workflowId, run.id)?.status).toBe("failed");
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    expect(dispatchByHand(item.id)).toBe("acquired");
  });

  it("is given back when the run is cancelled", async () => {
    const workflowId = saveAutoStart();
    const item = store.createWorkItem({ title: "run cancelled" });
    feed.pending.push(assigned("evt-cancel", item.id));
    await service.recover(now);
    const run = service.listRuns(workflowId, {}).items[0]!;
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:evt-cancel");

    await service.cancelRun({ workflowId, runId: run.id, reason: "Operator stopped it." });

    expect(service.getRun(workflowId, run.id)?.status).toBe("cancelled");
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    expect(dispatchByHand(item.id)).toBe("acquired");
  });
});
