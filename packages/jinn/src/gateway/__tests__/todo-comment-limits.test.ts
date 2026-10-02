import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome } from "./todo-mentions-harness.js";

// The edges of who a comment wakes: a mention that cannot start anyone, names
// in another case, replies to a system employee, and two sessions answering
// each other without end.
mentionTestHome("jinn-todo-comment-limits-");

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
let comments: typeof import("../../work-items/comments.js");
beforeAll(async () => {
  h = await loadMentionHarness();
  comments = await import("../../work-items/comments.js");
});
beforeEach(() => {
  delivered.length = 0;
});

/** System notes answering a comment; a note on a reply is stored under the thread root. */
const systemReplies = (todoId: string, commentId: string) =>
  comments.listComments(todoId).comments.filter((c) => (c.repliedToId ?? c.parentCommentId) === commentId && c.authorKind === "system");

describe("mentions that cannot be woken", () => {
  it("notes an employee whose engine cannot run, and still wakes the others in the comment", async () => {
    const item = h.store.createWorkItem({ title: "one offline" });
    const asked = await h.comment(item.id, "@offline and @alpha, please look");

    expect(systemReplies(item.id, asked.id).map((c) => c.body)).toEqual([expect.stringContaining("@offline was not woken.")]);
    expect(h.sessionsOf(item.id, "offline")).toEqual([]);
    expect(h.sessionsOf(item.id, "alpha")).toHaveLength(1);
  });

  it("wakes an employee whose name has capitals, however the mention is cased", async () => {
    const item = h.store.createWorkItem({ title: "cased" });
    await h.comment(item.id, "@casey-ops can you check?");

    expect(h.sessionsOf(item.id, "Casey-Ops")).toHaveLength(1);
  });
});

describe("replies between sessions", () => {
  it("does not wake a system employee's session", async () => {
    const item = h.store.createWorkItem({ title: "dispatcher asked" });
    const dispatcher = h.employeeSession("todo-dispatcher");
    h.store.linkSession(item.id, dispatcher.id);
    const options = await h.comment(item.id, "Nobody fits: pick one of these options.", { as: dispatcher.id });

    await h.comment(item.id, "Take the first option.", { parentCommentId: options.id });

    expect(h.deliveriesTo(dispatcher.id)).toEqual([]);
  });

  it("stops after the cap, and says so on the thread", async () => {
    const item = h.store.createWorkItem({ title: "ping pong" });
    const root = await h.comment(item.id, "@alpha and @bravo, sort it out between you");
    const [alpha] = h.sessionsOf(item.id, "alpha");
    const [bravo] = h.sessionsOf(item.id, "bravo");
    const { MAX_AGENT_REPLIES_PER_TODO } = await import("../todo-comment-routing.js");

    let last = await h.comment(item.id, "Opening.", { as: alpha.id, parentCommentId: root.id });
    for (let turn = 0; turn <= MAX_AGENT_REPLIES_PER_TODO; turn++) {
      last = await h.comment(item.id, `Answer ${turn}.`, { as: turn % 2 === 0 ? bravo.id : alpha.id, parentCommentId: last.id });
    }

    expect(h.deliveriesTo(alpha.id, "todo-agent-reply").length + h.deliveriesTo(bravo.id, "todo-agent-reply").length)
      .toBe(MAX_AGENT_REPLIES_PER_TODO);
    expect(systemReplies(item.id, last.id).map((c) => c.body)).toEqual([expect.stringContaining("Reply not delivered.")]);
  });
});
