import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";

mentionTestHome("jinn-mention-stopped-owner-");

const delivered = vi.hoisted(() => [] as string[]);
vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return { ...actual, deliverClaimedSessionDelivery: async (id: string) => { delivered.push(id); return "accepted" as const; } };
});

let h: Awaited<ReturnType<typeof loadMentionHarness>>;
beforeAll(async () => { h = await loadMentionHarness(); });
beforeEach(() => { delivered.length = 0; });

describe("a Todo mention for an employee whose session was stopped on purpose", () => {
  it("starts the employee a new session instead of aiming the wake at the stopped one", async () => {
    const parent = h.store.createWorkItem({ title: "parent", assignee: "alpha", status: "executing" });
    const owner = h.employeeSession("alpha");
    h.store.linkSession(parent.id, owner.id);
    const child = h.store.createWorkItem({ title: "child", source: "session", sourceRef: `session:${owner.id}:child` });
    expect((await h.delegate(child.id, "worker", sessionHeaders(owner.id))).status).toBeLessThan(300);

    const { markSessionStopped } = await import("../../sessions/stopped-marker.js");
    h.registry.updateSession(owner.id, { status: "interrupted" });
    markSessionStopped(owner.id);

    await h.comment(child.id, "@alpha please look at this");

    expect(h.deliveriesTo(owner.id, "todo-mention")).toEqual([]);
    expect(h.sessionsOf(child.id, "alpha")).toHaveLength(1);
    expect(h.sessionsOf(child.id, "alpha")[0]!.id).not.toBe(owner.id);
  });
});
