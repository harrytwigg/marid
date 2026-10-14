import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";

// Tagging the virtual org root (the portal) in a Todo comment.
const home = mentionTestHome("jinn-todo-mention-root-");
// No executive, so the portal is the root: a virtual one, under the portal's name.
fs.writeFileSync(path.join(home, "org", "org-root.yaml"), [
  "name: org-root", "displayName: Org-root", "department: platform", "rank: manager",
  "engine: codex", "model: gpt-5.5", "persona: org-root for mention tests", "",
].join("\n"));
const writePortalName = (portalName: string) =>
  fs.writeFileSync(path.join(home, "config.yaml"),
    `engines:\n  default: codex\n  claude:\n    bin: claude\n  codex:\n    bin: codex\nportal:\n  portalName: ${portalName}\n`);
writePortalName("COO");

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
let owner: typeof import("../work-item-owner.js");
beforeAll(async () => {
  h = await loadMentionHarness();
  comments = await import("../../work-items/comments.js");
  owner = await import("../work-item-owner.js");
});
beforeEach(() => {
  delivered.length = 0;
  writePortalName("COO");
});

const rootSessions = (todoId: string) =>
  h.registry.listSessionsByWorkItem(todoId).filter((session) => !session.employee);
const systemReplies = (todoId: string, commentId: string) =>
  comments.listComments(todoId).comments.filter((c) => c.parentCommentId === commentId && c.authorKind === "system");

describe("an @mention of the virtual org root", () => {
  it("starts one portal session on the Todo, linked as a consultation, and delivers later mentions into it", async () => {
    const item = h.store.createWorkItem({ title: "ask the coo", assignee: "worker", status: "executing" });
    const holder = h.executing(item.id);

    await h.comment(item.id, "@coo can you take a look?");
    const [session] = rootSessions(item.id);
    expect(rootSessions(item.id)).toHaveLength(1);
    expect(session).toMatchObject({ employee: null, parentSessionId: null, workItemRole: "consult" });
    expect(session.sessionKey).toMatch(new RegExp(`^todo:${item.id}:@root:`));
    expect(h.registry.getMessages(session.id)[0].content).toContain(`You were tagged in this comment on Todo ${item.id}`);
    expect(h.registry.getMessages(session.id)[0].content).toContain("@coo can you take a look?");
    expect(h.records.getEmployeeSessionRecord(item.id, "@root")?.sessionId).toBe(session.id);

    await h.comment(item.id, "And @COO, one more thing.");
    expect(rootSessions(item.id).map((s) => s.id)).toEqual([session.id]);
    expect(h.deliveriesTo(session.id, "todo-mention")).toHaveLength(1);

    // The claim and the assignee are the worker's still.
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(holder.id);
    expect(h.store.getWorkItem(item.id)).toMatchObject({ status: "executing", assignee: "worker" });
  });

  it("gives the session the root's standing but not the operator's close-as-done lane", async () => {
    const item = h.store.createWorkItem({ title: "standing" });
    await h.comment(item.id, "@coo over to you");
    const [session] = rootSessions(item.id);

    expect(h.registry.isPortalAgentSession(session)).toBe(true);
    expect(h.registry.isCoordinatorSession(session)).toBe(false);
    const closed = await h.call("POST", `/api/work-items/${item.id}/status`, { status: "done", note: "done", asOperator: true }, sessionHeaders(session.id));
    expect(closed.status).toBe(403);
    expect(String(closed.body.error)).toContain("asOperator is reserved");
  });

  it("starts one session for two near-simultaneous mentions", async () => {
    const item = h.store.createWorkItem({ title: "two at once" });
    await Promise.all([h.comment(item.id, "@coo one"), h.comment(item.id, "@coo two")]);
    expect(rootSessions(item.id)).toHaveLength(1);
  });

  it("is refused, on the thread, when an employee writes it", async () => {
    const item = h.store.createWorkItem({ title: "employee escalates" });
    const author = h.employeeSession("alpha");

    const asked = await h.comment(item.id, "Escalating to @coo.", { as: author.id });

    expect(rootSessions(item.id).filter((s) => s.id !== author.id)).toEqual([]);
    const [reply] = systemReplies(item.id, asked.id);
    expect(reply.body).toContain("@coo was not woken.");
    expect(reply.body).toContain("Only the operator can tag the org root, COO.");
  });

  it("follows the portal's name, as a mention spells it", async () => {
    writePortalName("Portal COO");
    expect(owner.virtualRootMention()).toEqual({ name: "Portal COO", mention: "portal-coo" });

    const item = h.store.createWorkItem({ title: "renamed portal" });
    const asked = await h.comment(item.id, "@coo are you there? @portal-coo you are.");

    expect(rootSessions(item.id)).toHaveLength(1);
    expect(systemReplies(item.id, asked.id).map((c) => c.body)).toEqual([
      '**@coo was not woken.** No employee or org root is named "coo".',
    ]);
  });

  it("is offered to the web by the org payload", async () => {
    const org = await h.call("GET", "/api/org", {});
    expect(org.body.virtualRoot).toEqual({ name: "COO", mention: "coo" });
  });
});

describe("a mention of a name that is nobody's", () => {
  it("says so on the thread when the operator wrote it", async () => {
    const item = h.store.createWorkItem({ title: "typo" });
    const asked = await h.comment(item.id, "@alhpa can you check?");
    expect(systemReplies(item.id, asked.id).map((c) => c.body)).toEqual([
      '**@alhpa was not woken.** No employee or org root is named "alhpa".',
    ]);
  });

  it("stays quiet when an employee wrote it", async () => {
    const item = h.store.createWorkItem({ title: "agent shorthand" });
    const author = h.employeeSession("alpha");
    const asked = await h.comment(item.id, "Waiting on @operator.", { as: author.id });
    expect(systemReplies(item.id, asked.id)).toEqual([]);
  });
});

describe("an employee named like the portal", () => {
  it("keeps the mention: it wakes the employee and the root is not offered", async () => {
    fs.writeFileSync(path.join(home, "org", "coo.yaml"), [
      "name: coo", "displayName: Coo", "department: platform", "rank: employee", "reportsTo: org-root",
      "engine: codex", "model: gpt-5.5", "persona: coo for mention tests", "",
    ].join("\n"));
    (await import("../org-registry.js")).refreshOrg();
    try {
      expect(owner.virtualRootMention()).toBeNull();
      const item = h.store.createWorkItem({ title: "employee coo" });
      await h.comment(item.id, "@coo hello");
      expect(h.sessionsOf(item.id, "coo")).toHaveLength(1);
      expect(rootSessions(item.id)).toEqual([]);
      const org = await h.call("GET", "/api/org", {});
      expect(org.body.virtualRoot).toBeNull();
    } finally {
      fs.rmSync(path.join(home, "org", "coo.yaml"));
      (await import("../org-registry.js")).refreshOrg();
    }
  });
});
