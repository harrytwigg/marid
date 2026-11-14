import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-delegation-contract-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Registry = typeof import("../registry.js");
type WorkItems = typeof import("../../work-items/store.js");
type Contract = typeof import("../delegation-completion-contract.js");

let registry: Registry;
let workItems: WorkItems;
let contract: Contract;

beforeAll(async () => {
  registry = await import("../registry.js");
  workItems = await import("../../work-items/store.js");
  contract = await import("../delegation-completion-contract.js");
  (await import("../../shared/db.js")).initDb();
});

describe("delegation completion contract atomic guard", () => {
  it("posts exactly one nudge when duplicate idle callbacks race", async () => {
    const item = workItems.createWorkItem({
      title: "Atomic completion contract",
      status: "executing",
      source: "delegation",
    });
    const session = registry.createSession({
      engine: "codex",
      source: "api",
      sourceRef: "api:atomic-contract",
      parentSessionId: "parent-atomic",
      transportMeta: { delegationCompletionTracked: true },
    });
    workItems.linkSession(item.id, session.id);
    const idleChild = registry.getSession(session.id)!;
    const postFollowUp = vi.fn(async () => undefined);
    const result = { result: "Progress update: the implementation is still in progress; tests are still running." };

    const outcomes = await Promise.all([
      contract.enforceDelegationCompletionContract(idleChild, result, { postFollowUp }),
      contract.enforceDelegationCompletionContract(idleChild, result, { postFollowUp }),
    ]);

    expect(postFollowUp).toHaveBeenCalledOnce();
    expect(outcomes.sort()).toEqual(["nudged", "suppress"]);
  });

  it("atomically clears only the stale guard under a racing claim", () => {
    const oldItem = workItems.createWorkItem({ title: "Old cycle", status: "executing", source: "delegation" });
    const newItem = workItems.createWorkItem({ title: "New cycle", status: "executing", source: "delegation" });
    const session = registry.createSession({
      engine: "codex",
      source: "api",
      sourceRef: "api:atomic-clear",
      parentSessionId: "parent-clear",
      transportMeta: { delegationCompletionTracked: true, preserved: "live" },
    });
    registry.claimDelegationCompletionNudge(session.id, oldItem.id);
    const staleSession = registry.getSession(session.id)!;
    registry.claimDelegationCompletionNudge(session.id, newItem.id);

    contract.clearDelegationCompletionContract(staleSession);

    expect(registry.getSession(session.id)?.transportMeta).toMatchObject({
      delegationCompletionTracked: true,
      preserved: "live",
      delegationCompletionContract: { workItemId: newItem.id, state: "nudged" },
    });
  });

  it("independently excludes a guarded child that already has a durable nudge receipt", () => {
    const item = workItems.createWorkItem({ title: "Pending durable nudge", status: "executing", source: "delegation" });
    const session = registry.createSession({
      engine: "codex",
      source: "api",
      sourceRef: "api:pending-durable-nudge",
      parentSessionId: "parent-pending-nudge",
      transportMeta: { delegationCompletionTracked: true },
    });
    workItems.linkSession(item.id, session.id);
    const attempt = registry.beginSessionAttempt(session.id)!;
    const idle = registry.completeSessionAttempt(session.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;
    registry.claimDelegationCompletionNudge(idle.id, item.id);
    registry.claimSessionDelivery({
      targetSessionId: idle.id,

      sourceKind: "session",
      sourceId: idle.id,
      sourceAttempt: idle.attemptToken!,
      sourceOutcome: "succeeded",
      sourceVersion: idle.attemptTerminalVersion!,
      deliveryKind: "delegation-completion-nudge",
      payload: { message: "continue", displayMessage: "continuing" },
    });

    expect(registry.listDelegationCompletionNudgedSessions().map(({ id }) => id)).not.toContain(idle.id);
  });
});

const NARRATION = { result: "Progress update: I am still working through the remaining checks." };

function delegatedChild(ref: string) {
  const item = workItems.createWorkItem({ title: ref, status: "executing", source: "delegation" });
  const session = registry.createSession({
    engine: "codex",
    source: "api",
    sourceRef: `api:${ref}`,
    parentSessionId: `parent-${ref}`,
    transportMeta: { delegationCompletionTracked: true },
  });
  workItems.linkSession(item.id, session.id);
  return { item, session };
}

/** Each settlement reads the session back, because the previous nudge advanced the guard. */
function settle(sessionId: string, result: { result: string }, postFollowUp: () => Promise<undefined>) {
  return contract.enforceDelegationCompletionContract(registry.getSession(sessionId)!, result, { postFollowUp });
}

describe("delegation completion nudge budget", () => {
  it("nudges twice and surfaces the third settlement", async () => {
    const { session } = delegatedChild("budget-two");
    const postFollowUp = vi.fn(async () => undefined);

    const outcomes = [
      await settle(session.id, NARRATION, postFollowUp),
      await settle(session.id, NARRATION, postFollowUp),
      await settle(session.id, NARRATION, postFollowUp),
    ];

    expect(outcomes).toEqual(["nudged", "nudged", "surface"]);
    expect(postFollowUp).toHaveBeenCalledTimes(2);
  });

  it("surfaces a nudged child that stops narrating before its budget is spent", async () => {
    const { session } = delegatedChild("stops-narrating");
    const postFollowUp = vi.fn(async () => undefined);

    expect(await settle(session.id, NARRATION, postFollowUp)).toBe("nudged");
    const outcome = await settle(session.id, { result: "Final report: implementation complete. All tests passed." }, postFollowUp);

    expect(outcome).toBe("surface");
    expect(postFollowUp).toHaveBeenCalledOnce();
  });

  it("resumes a guard persisted without a nudge count on its remaining budget", async () => {
    const { item, session } = delegatedChild("legacy-guard");
    registry.updateSession(session.id, {
      transportMeta: {
        delegationCompletionTracked: true,
        delegationCompletionContract: { workItemId: item.id, state: "nudged" },
      },
    });
    const postFollowUp = vi.fn(async () => undefined);

    const outcomes = [
      await settle(session.id, NARRATION, postFollowUp),
      await settle(session.id, NARRATION, postFollowUp),
    ];

    expect(outcomes).toEqual(["nudged", "surface"]);
    expect(postFollowUp).toHaveBeenCalledOnce();
  });

  it("posts exactly one second nudge when duplicate idle callbacks race", async () => {
    const { session } = delegatedChild("racing-second-nudge");
    const postFollowUp = vi.fn(async () => undefined);
    expect(await settle(session.id, NARRATION, postFollowUp)).toBe("nudged");
    const nudgedOnce = registry.getSession(session.id)!;

    const outcomes = await Promise.all([
      contract.enforceDelegationCompletionContract(nudgedOnce, NARRATION, { postFollowUp }),
      contract.enforceDelegationCompletionContract(nudgedOnce, NARRATION, { postFollowUp }),
    ]);

    expect(outcomes.sort()).toEqual(["nudged", "suppress"]);
    expect(postFollowUp).toHaveBeenCalledTimes(2);
  });

  it("rolls a failed second nudge back to the first, not to no guard at all", async () => {
    const { item, session } = delegatedChild("failed-second-nudge");
    const postFollowUp = vi.fn(async () => undefined);
    expect(await settle(session.id, NARRATION, postFollowUp)).toBe("nudged");
    postFollowUp.mockRejectedValueOnce(new Error("queue is down"));

    expect(await settle(session.id, NARRATION, postFollowUp)).toBe("pass");

    expect(registry.getSession(session.id)?.transportMeta).toMatchObject({
      delegationCompletionContract: { workItemId: item.id, state: "nudged", nudges: 1 },
    });
  });
});
