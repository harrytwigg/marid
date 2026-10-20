import { describe, expect, it, vi } from "vitest";
import { buildTalkControlManifest } from "../manifest.js";
import { TalkControlRuntime } from "../runtime.js";
import type { TalkControlReceipt, TalkControlReceiptStore } from "../types.js";

function call(overrides: Record<string, unknown> = {}) {
  return {
    talkSessionId: "talk-1",
    providerCallId: "call-1",
    providerItemId: "item-1",
    tool: "talk_comment_todo",
    arguments: JSON.stringify({ id: "ABC-1", body: "On it." }),
    caller: { kind: "operator" as const },
    ...overrides,
  };
}

describe("TalkControlRuntime", () => {
  it("replays a durable verified receipt after the runtime is rebuilt", async () => {
    const held = new Map<string, TalkControlReceipt>();
    const receipts: TalkControlReceiptStore = {
      get: (sessionId, callId) => held.get(`${sessionId}:${callId}`) ?? null,
      put: (receipt) => {
        const key = `${receipt.talkSessionId}:${receipt.providerCallId}`;
        const existing = held.get(key);
        if (existing) return {
          status: existing.requestFingerprint === receipt.requestFingerprint ? "replayed" as const : "conflict" as const,
          receipt: existing,
        };
        held.set(key, receipt);
        return { status: "stored" as const, receipt };
      },
    };
    const execute = vi.fn(async () => ({ data: { commentId: "wic_1" }, uiEffect: null }));
    const options = { manifest: buildTalkControlManifest(), execute, verify: async () => ({ ok: true, evidence: {} }), receipts };
    const first = await new TalkControlRuntime(options).dispatch(call());
    const afterRestart = await new TalkControlRuntime(options).dispatch(call());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(afterRestart).toEqual({ ...first, replayed: true });
  });

  it("makes concurrent provider replays await one verified receipt", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await held;
      return { data: { commentId: "wic_1" }, uiEffect: { invalidate: ["todo:ABC-1"] } };
    });
    const verify = vi.fn(async () => ({ ok: true, evidence: { commentId: "wic_1" } }));
    const runtime = new TalkControlRuntime({ manifest: buildTalkControlManifest(), execute, verify });

    const first = runtime.dispatch(call());
    const replay = runtime.dispatch(call());
    release();

    const [a, b] = await Promise.all([first, replay]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ ok: true, verified: true, replayed: false });
    expect(b).toEqual({ ...a, replayed: true });
  });

  it("rejects a reused provider id with different arguments", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => ({ data: {}, uiEffect: null }),
      verify: async () => ({ ok: true, evidence: {} }),
    });
    expect((await runtime.dispatch(call())).ok).toBe(true);
    await expect(runtime.dispatch(call({ arguments: JSON.stringify({ id: "ABC-1", body: "Different" }) })))
      .resolves.toMatchObject({ ok: false, code: "provider-call-conflict" });
  });

  it("fails non-operator and browser-target calls closed before execution", async () => {
    const execute = vi.fn(async () => ({ data: {}, uiEffect: null }));
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute,
      verify: async () => ({ ok: true, evidence: {} }),
    });

    await expect(runtime.dispatch(call({ caller: { kind: "session", callerId: "employee-session" } })))
      .resolves.toMatchObject({ ok: false, code: "operator-required" });
    await expect(runtime.dispatch(call({ providerCallId: "call-2", tool: "open_todo" })))
      .resolves.toMatchObject({ ok: false, code: "wrong-target" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never reports a mutation as successful when verification fails", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => ({ data: { commentId: "wic_1" }, uiEffect: null }),
      verify: async () => ({ ok: false, evidence: {} }),
    });

    await expect(runtime.dispatch(call())).resolves.toMatchObject({ ok: false, code: "verification-failed" });
  });

  it("does not durably cache a transient execution failure", async () => {
    const held = new Map<string, TalkControlReceipt>();
    const receipts: TalkControlReceiptStore = {
      get: (sessionId, callId) => held.get(`${sessionId}:${callId}`) ?? null,
      put: (receipt) => {
        held.set(`${receipt.talkSessionId}:${receipt.providerCallId}`, receipt);
        return { status: "stored", receipt };
      },
    };
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ data: { commentId: "wic_1" }, uiEffect: null });
    const options = {
      manifest: buildTalkControlManifest(),
      execute,
      verify: async () => ({ ok: true, evidence: {} }),
      receipts,
    };

    await expect(new TalkControlRuntime(options).dispatch(call()))
      .resolves.toMatchObject({ ok: false, code: "execution-failed" });
    await expect(new TalkControlRuntime(options).dispatch(call()))
      .resolves.toMatchObject({ ok: true, verified: true, replayed: false });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(held.size).toBe(1);
  });

  it("rejects missing, unknown, and wrongly typed arguments before execution", async () => {
    const execute = vi.fn(async () => ({ data: {}, uiEffect: null }));
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute,
      verify: async () => ({ ok: true, evidence: {} }),
    });
    await expect(runtime.dispatch(call({ arguments: JSON.stringify({ id: "ABC-1" }) })))
      .resolves.toMatchObject({ ok: false, code: "invalid-arguments" });
    await expect(runtime.dispatch(call({ providerCallId: "call-2", arguments: JSON.stringify({ id: "ABC-1", body: "ok", secret: "no" }) })))
      .resolves.toMatchObject({ ok: false, code: "invalid-arguments" });
    await expect(runtime.dispatch(call({ providerCallId: "call-3", tool: "talk_edit_todo", arguments: JSON.stringify({ id: "ABC-1", expectedVersion: "1", title: "x" }) })))
      .resolves.toMatchObject({ ok: false, code: "invalid-arguments" });
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * The mute-failure regression. Before this, every
   * adapter throw arrived as one house sentence, so "Todo ZZZ-999 not found"
   * and "Employee dana not found" were indistinguishable to the model and the
   * operator was told nothing. Revert `executionReason` to a constant and this
   * fails.
   */
  it("carries the adapter's own reason instead of one house sentence", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => { throw new Error("Todo ZZZ-999 not found"); },
      verify: async () => ({ ok: true, evidence: {} }),
    });

    await expect(runtime.dispatch(call({ tool: "read_todo", arguments: JSON.stringify({ id: "ZZZ-999" }) })))
      .resolves.toEqual({ ok: false, code: "execution-failed", error: "Todo ZZZ-999 not found" });
  });

  it("bounds an adapter reason so no single message can run away", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => { throw new Error("x".repeat(5000)); },
      verify: async () => ({ ok: true, evidence: {} }),
    });

    const result = await runtime.dispatch(call());
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toHaveLength(300);
  });

  it("names the check that did not match and the evidence it found", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => ({ data: {}, uiEffect: null }),
      verify: async () => ({ ok: false, evidence: { id: "ABC-1", assignee: "someone-else" } }),
    });

    await expect(runtime.dispatch(call({ tool: "talk_assign_todo", arguments: JSON.stringify({ id: "ABC-1", assignee: "a-worker" }) })))
      .resolves.toEqual({
        ok: false,
        code: "verification-failed",
        error: "talk_assign_todo did not match its todo-assignment-reread check; found id=ABC-1, assignee=someone-else.",
      });
  });

  it("names the tool a preflight refusal was about", async () => {
    const runtime = new TalkControlRuntime({
      manifest: buildTalkControlManifest(),
      execute: async () => ({ data: {}, uiEffect: null }),
      verify: async () => ({ ok: true, evidence: {} }),
    });

    await expect(runtime.dispatch(call({ tool: "talk_invent_todo" })))
      .resolves.toMatchObject({ ok: false, code: "unknown-operation", error: "talk_invent_todo is not in the Talk manifest." });
  });
});
