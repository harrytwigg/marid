import { describe, expect, it } from "vitest";
import { buildSessionTools } from "../session-tools.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/** What `send_to_session` forwards of `supersedes` and tells its caller about where the message landed. */

function sendTool(): JinnMcpTool {
  const tool = buildSessionTools().find((t) => t.name === "send_to_session");
  if (!tool) throw new Error("no send_to_session");
  return tool;
}

function gateway(reply: { status: number; body: unknown }) {
  const bodies: unknown[] = [];
  const ctx: JinnMcpContext = {
    gatewayUrl: "http://gateway.test",
    callerSessionId: "sender",
    sessionCapability: "cap-test",
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return { status: reply.status, text: async () => JSON.stringify(reply.body) } as unknown as Response;
    }) as unknown as typeof fetch,
  };
  return { bodies, ctx };
}

type Out = Record<string, unknown> & { hint: string };

describe("send_to_session supersedes", () => {
  it("forwards supersedes only when given", async () => {
    const plain = gateway({ status: 200, body: { status: "queued", queueItemId: "q1" } });
    await sendTool().handler({ sessionId: "b", message: "hi" }, plain.ctx);
    expect(plain.bodies[0]).toEqual({ message: "hi" });

    const replacing = gateway({ status: 200, body: { status: "queued", queueItemId: "q2", superseded: "withdrawn" } });
    await sendTool().handler({ sessionId: "b", message: "hi again", supersedes: "q1" }, replacing.ctx);
    expect(replacing.bodies[0]).toEqual({ message: "hi again", supersedes: "q1" });
  });

  it("tells a sender whose target is mid-turn how to take the message back, and how many of its are queued", async () => {
    const { ctx } = gateway({ status: 200, body: { status: "queued", queueItemId: "q2", targetRunning: true, queuedFromYou: 2 } });
    const out = (await sendTool().handler({ sessionId: "b", message: "m" }, ctx)) as Out;
    expect(out).toMatchObject({ status: "queued", queueId: "q2", targetRunning: true, queuedFromYou: 2 });
    expect(out.hint).toMatch(/mid-turn/);
    expect(out.hint).toMatch(/2 of yours are queued/);
    expect(out.hint).toMatch(/supersedes=queueId/);
  });

  it("says nothing about waiting when the target is idle", async () => {
    const { ctx } = gateway({ status: 200, body: { status: "queued", queueItemId: "q3", targetRunning: false, queuedFromYou: 1 } });
    const out = (await sendTool().handler({ sessionId: "b", message: "m" }, ctx)) as Out;
    expect(out.hint).not.toMatch(/mid-turn|supersedes/);
  });

  it("reports whether the replaced message was withdrawn or had already left the queue", async () => {
    const withdrawn = gateway({ status: 200, body: { status: "queued", queueItemId: "q4", targetRunning: true, queuedFromYou: 1, superseded: "withdrawn" } });
    expect(((await sendTool().handler({ sessionId: "b", message: "m", supersedes: "q1" }, withdrawn.ctx)) as Out).hint).toMatch(/withdrawn unread/);

    const late = gateway({ status: 200, body: { status: "queued", queueItemId: "q5", targetRunning: true, queuedFromYou: 1, superseded: "too-late" } });
    expect(((await sendTool().handler({ sessionId: "b", message: "m", supersedes: "q1" }, late.ctx)) as Out).hint).toMatch(/already left the queue/);
  });

  it("does not call an identical resend a new message", async () => {
    const { ctx } = gateway({ status: 200, body: { status: "duplicate", queueItemId: "q2", superseded: "withdrawn" } });
    const out = (await sendTool().handler({ sessionId: "b", message: "beta", supersedes: "q1" }, ctx)) as Out;
    expect(out).toMatchObject({ status: "duplicate", queueId: "q2" });
    expect(out.hint).toMatch(/Not queued again/);
    expect(out.hint).toMatch(/withdrawn unread/);
  });

  it("passes the gateway's refusal of a foreign id through readable", async () => {
    const { ctx } = gateway({ status: 400, body: { error: 'supersedes "q9" is not a message you sent to this session' } });
    await expect(sendTool().handler({ sessionId: "b", message: "m", supersedes: "q9" }, ctx)).rejects.toThrow(
      /rejected \(400\).*not a message you sent/,
    );
  });
});
