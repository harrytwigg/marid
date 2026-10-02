import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";

// A delegation into an employee's live session on a Todo: who the session
// reports to turn by turn, what it refuses, what it says it ignored, how a
// retry is recognised, and Talk taking the same path.
mentionTestHome("jinn-todo-delegation-turns-");

const delivered = vi.hoisted(() => [] as string[]);
vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return {
    ...actual,
    deliverClaimedSessionDelivery: async (id: string) => {
      delivered.push(id);
      return "accepted" as const;
    },
  };
});

let h: Awaited<ReturnType<typeof loadMentionHarness>>;
beforeAll(async () => {
  h = await loadMentionHarness();
});
beforeEach(() => {
  delivered.length = 0;
});

describe("a delegation that lands in a live session", () => {
  it("refuses a session delegating its own Todo to its own employee", async () => {
    const item = h.store.createWorkItem({ title: "self", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);

    const res = await h.delegate(item.id, "worker", sessionHeaders(holder.id));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("would land in this same session");
    expect(h.deliveriesTo(holder.id)).toEqual([]);
  });

  it("leaves the turn it lands in reporting where it did, and takes over from the next", async () => {
    const item = h.store.createWorkItem({ title: "asked, then handed over" });
    await h.comment(item.id, "@alpha quick question?");
    const [consult] = h.sessionsOf(item.id, "alpha");
    const asking = h.startTurn(consult.id);
    const delegator = h.employeeSession("org-root");

    expect((await h.delegate(item.id, "alpha", sessionHeaders(delegator.id))).body.reused).toBe(true);

    // The mention's turn settles: nobody was waiting on it, and the delegator is not told.
    const answered = h.registry.updateSession(asking.id, { attemptOutcome: "succeeded", attemptTerminalVersion: 1 })!;
    expect(h.delegation.reportingParentSessionId(answered)).toBeNull();
    await h.callbacks.notifyParentSessionAndWait(answered, { result: "The answer to the question." });
    expect(h.deliveriesTo(delegator.id)).toEqual([]);

    // The brief's turn reports to the delegator.
    const briefTurn = h.registry.updateSession(h.startTurn(consult.id).id, { attemptOutcome: "succeeded", attemptTerminalVersion: 1 })!;
    await h.callbacks.notifyParentSessionAndWait(briefTurn, { result: "Done: the delegated work is finished." });
    expect(h.deliveriesTo(delegator.id, "parent-completion")).toHaveLength(1);
  });

  it("says when the session keeps a selection other than the one the delegation resolved to", async () => {
    const item = h.store.createWorkItem({ title: "different model" });
    await h.comment(item.id, "@bravo look");
    const [consult] = h.sessionsOf(item.id, "bravo");
    h.registry.updateSession(consult.id, { status: "idle", model: "older-model" });

    const res = await h.delegate(item.id, "bravo");

    expect(res.body).toMatchObject({ reused: true, model: "older-model", selectionIgnored: { engine: "codex", model: "gpt-5.5" } });
  });

  it("answers a retry with the same idempotency key as a replay of the reuse", async () => {
    const item = h.store.createWorkItem({ title: "retried" });
    await h.comment(item.id, "@alpha look");
    const [consult] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(consult.id, { status: "idle" });
    const body = { workItemId: item.id, employee: "alpha", task: "Take it over.", idempotencyKey: "retry-me" };

    const first = await h.call("POST", "/api/delegations", body);
    const again = await h.call("POST", "/api/delegations", body);

    expect(first.body).toMatchObject({ sessionId: consult.id, reused: true });
    expect(again.body).toMatchObject({ sessionId: consult.id, replayed: true });
    expect(h.deliveriesTo(consult.id, "todo-delegation")).toHaveLength(1);
  });
});

describe("a Talk delegation", () => {
  it("lands in the employee's live session on the Todo and reports to the Talk session from its next turn", async () => {
    const { claimTalkDelegation } = await import("../../talk/control/delegation-adapter.js");
    const item = h.store.createWorkItem({ title: "by voice" });
    await h.comment(item.id, "@alpha have a look");
    const [consult] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(consult.id, { status: "idle" });
    const talk = h.employeeSession("org-root");

    const claimed = claimTalkDelegation({
      context: h.context,
      sourceSessionId: talk.id,
      todoId: item.id,
      prompt: "Take this Todo over.",
      employee: { name: "alpha", department: "platform", engine: "codex", model: "gpt-5.5" },
      call: { talkSessionId: "talk-1", providerCallId: "call-1", idempotencyKey: "talk-delegate-1" } as never,
    });

    expect(claimed.session.id).toBe(consult.id);
    expect(h.sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(h.registry.getSession(consult.id)?.workItemRole).toBe("execute");
    expect(h.delegation.reportingParentSessionId(h.startTurn(consult.id))).toBe(talk.id);
  });
});
