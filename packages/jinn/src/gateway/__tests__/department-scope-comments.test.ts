import { as, context, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { addComment } from "../../work-items/comment-add.js";
import { listComments, type WorkItemComment } from "../../work-items/comments.js";
import { routeTodoComment } from "../todo-comment-routing.js";
import type { Session } from "../../shared/types.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * A comment can wake an employee (an @mention) or deliver into another session (a reply).
 * From a scoped session both follow the rules of spawn and send_to_session: a mention
 * wakes only D's members, a reply reaches only a session bound to D or the author's own
 * requester. An unscoped author is held only by what a scoped target allows: a scoped
 * session cannot be linked to a Todo outside its department. Complements the smoke
 * tests in department-scope-gate.test.ts.
 */

let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let registry: Awaited<ReturnType<typeof startScopedHarness>>["registry"];
let coo: Session;
let stranger: Session;
let peer: Session;
let scopedAuthor: Session;
let eng: Session;
let seq = 0;

beforeAll(async () => {
  ({ workItems, registry } = await startScopedHarness());
  coo = await sessionOf(null);
  stranger = await sessionOf(null);
  peer = await sessionOf("side-qa");
  scopedAuthor = await sessionOf("side-dev", { parentSessionId: coo.id });
  eng = await sessionOf("eng-dev");
});

const todoIn = (department: string | null): WorkItem => workItems.createWorkItem({ title: `comment-${seq++}`, ...(department ? { department } : {}) });
const say = (item: WorkItem, session: Session, body: string, extra: { repliedTo?: WorkItemComment } = {}) =>
  addComment({
    workItemId: item.id, body, sessionId: session.id,
    author: session.employee ?? "operator", authorKind: session.employee ? "employee" : "operator",
    ...(extra.repliedTo ? { parentCommentId: extra.repliedTo.id } : {}),
  });
const notices = (item: WorkItem, comment: WorkItemComment) => listComments(item.id).comments.filter((entry) => entry.parentCommentId === comment.id && entry.authorKind === "system").map((entry) => entry.body);

describe("a mention from a scoped session", () => {
  it("wakes a member of its department, in a session bound to it", () => {
    const item = todoIn("side-project");
    const wakes = routeTodoComment(context, say(item, scopedAuthor, "@side-qa please review"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ employee: "side-qa", kind: "mention" });
    expect(registry.getSession(wakes[0]!.sessionId)?.scopeDepartment).toBe("side-project");
  });

  it.each(["eng-dev", "other-dev"])("does not wake @%s, outside its department, and says so on the thread", (name) => {
    const item = todoIn("side-project");
    const comment = say(item, scopedAuthor, `@${name} look`);
    expect(routeTodoComment(context, comment)).toEqual([]);
    expect(notices(item, comment)).toEqual([expect.stringContaining(`@${name} was not woken.** a session scoped to department "side-project" can only wake that department's members.`)]);
  });

  it("wakes the members and refuses the rest of one comment, each on its own", () => {
    const item = todoIn("side-project");
    const comment = say(item, scopedAuthor, "@side-qa and @eng-dev and @other-dev");
    expect(routeTodoComment(context, comment).map((wake) => wake.employee)).toEqual(["side-qa"]);
    expect(notices(item, comment)).toHaveLength(2);
  });
});

describe("a reply from a scoped session", () => {
  it("is delivered to its own requester though that session is unscoped, and to a session bound to its department", () => {
    const item = todoIn("side-project");
    const asked = say(item, coo, "please take this");
    expect(routeTodoComment(context, say(item, scopedAuthor, "done", { repliedTo: asked })).map((wake) => [wake.sessionId, wake.kind])).toEqual([[coo.id, "reply"]]);
    const peers = say(item, peer, "my notes");
    expect(routeTodoComment(context, say(item, scopedAuthor, "thanks", { repliedTo: peers })).map((wake) => wake.sessionId)).toEqual([peer.id]);
  });

  it("is not delivered into any other unscoped session", () => {
    const item = todoIn("side-project");
    const asked = say(item, stranger, "who is on this?");
    expect(routeTodoComment(context, say(item, scopedAuthor, "me", { repliedTo: asked }))).toEqual([]);
  });
});

describe("the same comments from an unscoped author", () => {
  it("wake a scoped member on a Todo in its department", () => {
    const inside = todoIn("side-project");
    expect(routeTodoComment(context, say(inside, eng, "@side-qa can you check")).map((wake) => wake.employee)).toEqual(["side-qa"]);
  });

  it("cannot wake a scoped member on a Todo outside its department: the session cannot be linked outside its department, and the thread says so", () => {
    const company = todoIn(null);
    const comment = say(company, eng, "@side-dev can you help?");
    expect(routeTodoComment(context, comment)).toEqual([]);
    const [notice] = notices(company, comment);
    expect(notice).toMatch(/^\*\*@side-dev was not woken\.\*\*/);
    expect(notice).toMatch(/department "side-project"/);
    expect(registry.listSessions().some((session) => session.employee === "side-dev" && session.workItemId === company.id)).toBe(false);
  });

  it("are not held by the scoped rules when mentioning unscoped members, or replying to an unscoped session", () => {
    const company = todoIn("engineering");
    expect(routeTodoComment(context, say(company, coo, "@eng-dev hello")).map((wake) => wake.employee)).toEqual(["eng-dev"]);
    const asked = say(company, stranger, "question");
    expect(routeTodoComment(context, say(company, eng, "answer", { repliedTo: asked })).map((wake) => wake.sessionId)).toEqual([stranger.id]);
  });

  it("deliver a reply into a scoped session working a Todo in its department", () => {
    const item = todoIn("side-project");
    const theirs = say(item, peer, "status?");
    expect(routeTodoComment(context, say(item, eng, "all good", { repliedTo: theirs })).map((wake) => wake.sessionId)).toEqual([peer.id]);
  });
});

describe("a scoped create naming a sprint", () => {
  const scoped = () => as(scopedAuthor.id);

  it.each([["active"], ["next"], [null], [""]])("is refused whatever the sprint is (%j), and nothing is created", async (sprint) => {
    const before = workItems.listWorkItems({}).length;
    const refused = await scoped()("POST", "/api/work-items", { title: "sprinted", sprint });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/sprints are the operator's/);
    expect(workItems.listWorkItems({}).length).toBe(before);
  });

  it("is not refused for leaving it out, and an unscoped session's sprint is not the gate's to refuse", async () => {
    expect((await scoped()("POST", "/api/work-items", { title: "no sprint" })).status).toBe(201);
    const unscoped = await as(eng.id)("POST", "/api/work-items", { title: "sprinted", sprint: "active" });
    expect(unscoped.body?.error ?? "").not.toMatch(/department-scoped/);
  });
});
