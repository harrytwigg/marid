import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TalkControlReceipt, TalkControlReceiptStore } from "../types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-domain-resilience-"));
process.env.JINN_HOME = home;

let createRuntime: typeof import("../domain-adapters.js").createTalkDomainRuntime;
let manifest: import("../types.js").TalkControlManifest;
let workItems: typeof import("../../../work-items/store.js");
let comments: typeof import("../../../work-items/comments.js");
let sessions: typeof import("../../../sessions/registry.js");
let claimDelegation: typeof import("../delegation-adapter.js").claimTalkDelegation;

beforeAll(async () => {
  ({ createTalkDomainRuntime: createRuntime } = await import("../domain-adapters.js"));
  manifest = (await import("../manifest.js")).buildTalkControlManifest();
  workItems = await import("../../../work-items/store.js");
  comments = await import("../../../work-items/comments.js");
  sessions = await import("../../../sessions/registry.js");
  ({ claimTalkDelegation: claimDelegation } = await import("../delegation-adapter.js"));
  (await import("../../../shared/db.js")).initDb();
});

function caller() {
  return { kind: "operator", principal: "operator" } as const;
}

describe("Talk domain retry resilience", () => {
  it("returns executable coverage or an exact named gap without inventing a command", async () => {
    const host = {
      sourceSessionId: "normal-talk-chat",
      context: { getConfig: () => ({ gateway: {}, engines: {} }) },
    } as unknown as Parameters<typeof createRuntime>[1];
    const ask = (providerCallId: string, capability: string) => createRuntime(manifest, host).dispatch({
      talkSessionId: "talk-capabilities",
      providerCallId,
      tool: "read_talk_capability",
      arguments: JSON.stringify({ capability }),
      caller: caller(),
    });

    await expect(ask("capability-supported", "todo-core")).resolves.toMatchObject({
      ok: true,
      verified: true,
      data: { capability: "todo-core", status: "supported", operations: expect.arrayContaining(["talk_edit_todo"]) },
    });
    await expect(ask("capability-gap", "notes")).resolves.toMatchObject({
      ok: true,
      verified: true,
      data: { capability: "notes", status: "explicit-gap", reason: "notes-command-adapter-missing" },
    });
    await expect(ask("capability-unknown", "not-a-lane")).resolves.toMatchObject({
      ok: true,
      verified: true,
      data: { capability: "not-a-lane", status: "unknown", knownCapabilities: expect.any(Array) },
    });
  });

  it("replays a committed comment after the outer receipt write is lost", async () => {
    const item = workItems.createWorkItem({ title: "Survive the lost receipt" });
    const stored = new Map<string, TalkControlReceipt>();
    let loseFirstReceipt = true;
    const receipts: TalkControlReceiptStore = {
      get: (sessionId, callId) => stored.get(`${sessionId}:${callId}`) ?? null,
      put: (receipt) => {
        if (loseFirstReceipt) {
          loseFirstReceipt = false;
          throw new Error("simulated lost receipt write");
        }
        stored.set(`${receipt.talkSessionId}:${receipt.providerCallId}`, receipt);
        return { status: "stored", receipt };
      },
    };
    const host = {
      sourceSessionId: "normal-talk-chat",
      receipts,
      context: { getConfig: () => ({ gateway: {}, engines: {} }) },
    } as unknown as Parameters<typeof createRuntime>[1];
    const dispatch = {
      talkSessionId: "talk-session-1",
      providerCallId: "provider-call-comment-1",
      tool: "talk_comment_todo",
      arguments: JSON.stringify({ id: item.id, body: "Only once" }),
      caller: caller(),
    };

    await expect(createRuntime(manifest, host).dispatch(dispatch)).rejects.toThrow(/lost receipt/);
    const replay = await createRuntime(manifest, host).dispatch(dispatch);

    expect(replay).toMatchObject({ ok: true, verified: true, replayed: false });
    expect(comments.listComments(item.id).comments.map((comment) => comment.body)).toEqual(["Only once"]);
    expect(workItems.getWorkItem(item.id)?.version).toBe(item.version + 1);
  });

  it("reuses one complete delegation after its queue settles and rejects changed input", async () => {
    const item = workItems.createWorkItem({ title: "Delegate exactly once" });
    const parent = sessions.createSession({ engine: "codex", source: "talk", sourceRef: "talk:parent" });
    const base = {
      context: { getConfig: () => ({ gateway: {}, engines: {} }) } as unknown as Parameters<typeof claimDelegation>[0]["context"],
      sourceSessionId: parent.id,
      todoId: item.id,
      prompt: "Implement the bounded change.",
      employee: { name: "a-worker", department: "platform", engine: "codex" },
      call: {
        talkSessionId: "talk-session-2",
        providerCallId: "provider-call-delegate-1",
        idempotencyKey: "talk:talk-session-2:provider-call-delegate-1",
        caller: caller(),
      },
    };

    const first = claimDelegation(base);
    sessions.markQueueItemCompleted(first.queueItemId);
    sessions.updateSession(first.session.id, { status: "interrupted" });
    const replay = claimDelegation(base);

    expect(replay).toMatchObject({ replayed: true, session: { id: first.session.id, status: "interrupted" } });
    expect(sessions.getMessages(first.session.id).map((message) => message.content)).toEqual([base.prompt]);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "a-worker", department: "platform" });
    const rows = (await import("../../../shared/db.js")).initDb()
      .prepare("SELECT COUNT(*) AS count FROM queue_items WHERE session_id = ?")
      .get(first.session.id) as { count: number };
    expect(rows.count).toBe(1);
    expect(() => claimDelegation({ ...base, prompt: "A changed retry." })).toThrow(/different input/i);
  });
});
