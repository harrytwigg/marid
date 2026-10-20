import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempHome } from "./db-fixtures.js";
import type { WorkItemEvent } from "../../work-items/store.js";

useTempHome("jinn-board-hooks-payload-");

type Store = typeof import("../../work-items/store.js");
type Payload = typeof import("../payload.js");
type Events = typeof import("../events.js");
let store: Store;
let payload: Payload;
let events: Events;
let comments: typeof import("../../work-items/comments.js");
let labels: typeof import("../../work-items/labels.js");
let transitions: typeof import("../../work-items/transitions.js");
let registry: typeof import("../../sessions/registry.js");
let tap: typeof import("../../work-items/board-event-tap.js");
const seen: WorkItemEvent[] = [];

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  payload = await import("../payload.js");
  events = await import("../events.js");
  comments = await import("../../work-items/comments.js");
  labels = await import("../../work-items/labels.js");
  transitions = await import("../../work-items/transitions.js");
  registry = await import("../../sessions/registry.js");
  tap = await import("../../work-items/board-event-tap.js");
  (await import("../../shared/db.js")).initDb();
  tap.setBoardEventListener((event) => { seen.push(event); });
});

afterAll(() => tap.setBoardEventListener(null));

function lastOf(kind: string, todoId: string): WorkItemEvent {
  const hit = [...seen].reverse().find((event) => event.kind === kind && event.workItemId === todoId);
  if (!hit) throw new Error(`no ${kind} event for ${todoId}`);
  return hit;
}

function build(event: WorkItemEvent) {
  const name = events.boardEventName(event);
  if (!name) throw new Error(`${event.kind} is not a board event`);
  return payload.buildBasePayload(event, name)!;
}

describe("boardEventName", () => {
  const row = (over: Partial<WorkItemEvent>): WorkItemEvent => ({
    id: "wie_x", workItemId: "T-1", kind: "note", fromStatus: null, toStatus: null, actor: null, detail: null, createdAt: "2026-01-01T00:00:00.000Z", ...over,
  });

  it("maps the audit rows to the six events", () => {
    expect(events.boardEventName(row({ kind: "created" }))).toBe("todo.created");
    expect(events.boardEventName(row({ kind: "status_change", fromStatus: "backlog", toStatus: "executing" }))).toBe("todo.status_changed");
    expect(events.boardEventName(row({ kind: "escalated", fromStatus: "executing", toStatus: "blocked" }))).toBe("todo.status_changed");
    expect(events.boardEventName(row({ kind: "note", detail: { assignee: "x" } }))).toBe("todo.assigned");
    expect(events.boardEventName(row({ kind: "metadata_edited", detail: { updatedFields: ["title", "assignee"] } }))).toBe("todo.assigned");
    expect(events.boardEventName(row({ kind: "session_linked", detail: { via: "delegation" } }))).toBe("todo.delegated");
    expect(events.boardEventName(row({ kind: "session_linked", detail: { via: "dispatch" } }))).toBe("todo.dispatched");
    expect(events.boardEventName(row({ kind: "comment_added", detail: { commentId: "wic_1" } }))).toBe("todo.commented");
  });

  it("maps everything else to nothing", () => {
    expect(events.boardEventName(row({ kind: "session_linked", detail: { sessionId: "s" } }))).toBeNull();
    expect(events.boardEventName(row({ kind: "session_linked", detail: null }))).toBeNull();
    expect(events.boardEventName(row({ kind: "escalated", toStatus: null }))).toBeNull();
    expect(events.boardEventName(row({ kind: "status_change", toStatus: null }))).toBeNull();
    expect(events.boardEventName(row({ kind: "note", detail: { note: "just a note" } }))).toBeNull();
    expect(events.boardEventName(row({ kind: "metadata_edited", detail: { updatedFields: ["title"] } }))).toBeNull();
    expect(events.boardEventName(row({ kind: "label_changed" }))).toBeNull();
  });
});

describe("the event tap", () => {
  it("hands every appended event to the listener, and a throwing listener never reaches the writer", () => {
    const before = seen.length;
    const item = store.createWorkItem({ title: "tapped" });
    expect(seen.length).toBeGreaterThan(before);
    expect(seen.some((event) => event.kind === "created" && event.workItemId === item.id)).toBe(true);
    tap.setBoardEventListener(() => { throw new Error("listener blew up"); });
    expect(() => store.createWorkItem({ title: "still written" })).not.toThrow();
    tap.setBoardEventListener((event) => { seen.push(event); });
  });
});

describe("payloads", () => {
  it("todo.created: the Todo, its labels and children, no move", () => {
    const parent = store.createWorkItem({ title: "Parent", department: "platform", assignee: "senior-developer", createdBy: "operator" });
    labels.createLabel({ name: "auto-merge" });
    labels.createLabel({ name: "urgent" });
    labels.addWorkItemLabels(parent.id, ["auto-merge", "urgent"], "operator");
    const child = store.createWorkItem({ title: "Child", parentId: parent.id });
    const made = build(lastOf("created", parent.id));
    expect(made).toMatchObject({
      version: 1, event: "todo.created", from: null, to: null, text: null, prUrl: null, sessionId: null,
      todo: {
        id: parent.id, title: "Parent", status: "backlog", department: "platform", assignee: "senior-developer",
        parentId: null, rootId: parent.id, labels: ["auto-merge", "urgent"], childIds: [child.id], reviewAddressee: { kind: "operator" }, url: `/todos/${parent.id}`,
      },
    });
    expect(made.eventId).toBe(lastOf("created", parent.id).id);
    expect(made.at).toBe(lastOf("created", parent.id).createdAt);
    expect(build(lastOf("created", child.id)).todo).toMatchObject({ parentId: parent.id, rootId: parent.id, childIds: [] });
  });

  it("todo.status_changed: from, to, the note as text and the current Todo state", () => {
    const item = store.createWorkItem({ title: "Moves", assignee: "senior-developer" });
    transitions.transition(item.id, "executing", "operator", { human: true, manual: true });
    transitions.transition(item.id, "in_review", "operator", { detail: { note: "done, see https://github.com/o/r/pull/9" } });
    const moved = build(lastOf("status_change", item.id));
    expect(moved).toMatchObject({
      event: "todo.status_changed", from: "executing", to: "in_review", text: "done, see https://github.com/o/r/pull/9",
      prUrl: "https://github.com/o/r/pull/9", actor: { raw: "operator", kind: "operator" }, todo: { status: "in_review" },
    });
  });

  it("actor: an employee by session, by actorEmployee, the operator, and system", () => {
    const item = store.createWorkItem({ title: "Actors" });
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:actor", employee: "merger" });
    const bare = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:bare" });
    transitions.transition(item.id, "executing", `session:${session.id}`, { human: true, manual: true });
    expect(build(lastOf("status_change", item.id)).actor).toEqual({ raw: `session:${session.id}`, kind: "employee", employee: "merger", sessionId: session.id });
    transitions.transition(item.id, "blocked", `session:${bare.id}`, { detail: { actorEmployee: "named-employee" }, blockKind: "needs_input" });
    expect(build(lastOf("status_change", item.id)).actor).toMatchObject({ kind: "employee", employee: "named-employee", sessionId: bare.id });
    transitions.transition(item.id, "executing", `session:${bare.id}`, { human: true });
    expect(build(lastOf("status_change", item.id)).actor).toEqual({ raw: `session:${bare.id}`, kind: "system", sessionId: bare.id });
    transitions.transition(item.id, "in_review", "reconciler");
    expect(build(lastOf("status_change", item.id)).actor).toEqual({ raw: "reconciler", kind: "system" });
  });

  it("todo.assigned: a note carrying the assignee, and a metadata edit of it", () => {
    const item = store.createWorkItem({ title: "Assigned", department: "platform" });
    transitions.assignWorkItem(item.id, "senior-developer", "platform", "operator");
    const assigned = build(lastOf("note", item.id));
    expect(assigned).toMatchObject({ event: "todo.assigned", from: null, to: null, todo: { assignee: "senior-developer" }, actor: { kind: "operator" } });
    transitions.assignWorkItem(item.id, "junior-developer", "platform", "session:s-9", { actorEmployee: "senior-developer" });
    expect(build(lastOf("note", item.id)).actor).toMatchObject({ kind: "employee", employee: "senior-developer" });
    store.updateWorkItemConditional(item.id, { assignee: "@operator" }, { expectedVersion: store.getWorkItem(item.id)!.version, actor: "operator" });
    expect(build(lastOf("metadata_edited", item.id))).toMatchObject({ event: "todo.assigned", todo: { assignee: "@operator" } });
  });

  it("todo.delegated and todo.dispatched carry the linked session; a link without via is no event", () => {
    const item = store.createWorkItem({ title: "Linked" });
    const delegate = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:delegate", employee: "dev" });
    const dispatched = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:dispatched", employee: "dev" });
    const plain = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:plain", employee: "dev" });
    store.linkSession(item.id, delegate.id, "session:boss", "execute", { via: "delegation" });
    store.linkSession(item.id, dispatched.id, undefined, "execute", { via: "dispatch" });
    store.linkSession(item.id, plain.id, undefined, "execute");
    const events_ = seen.filter((event) => event.kind === "session_linked" && event.workItemId === item.id);
    expect(events_.map((event) => events.boardEventName(event))).toEqual(["todo.delegated", "todo.dispatched", null]);
    expect(build(events_[0])).toMatchObject({ event: "todo.delegated", sessionId: delegate.id, from: null, actor: { raw: "session:boss", kind: "system" } });
    expect(build(events_[1])).toMatchObject({ event: "todo.dispatched", sessionId: dispatched.id, actor: { raw: null, kind: "system" } });
  });

  it("todo.commented: the body as text, the comment's author and session as the actor", () => {
    const item = store.createWorkItem({ title: "Commented" });
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:commenter", employee: "merger" });
    comments.addComment({ workItemId: item.id, body: "Looks good https://github.com/o/r/pull/4", author: "merger", authorKind: "employee", sessionId: session.id });
    const mine = build(lastOf("comment_added", item.id));
    expect(mine).toMatchObject({ event: "todo.commented", text: "Looks good https://github.com/o/r/pull/4", prUrl: "https://github.com/o/r/pull/4", from: null, to: null });
    expect(mine.actor).toEqual({ raw: "merger", kind: "employee", employee: "merger", sessionId: session.id });
    comments.addComment({ workItemId: item.id, body: "ok", author: "operator", authorKind: "operator" });
    expect(build(lastOf("comment_added", item.id)).actor).toEqual({ raw: "operator", kind: "operator" });
    comments.addComment({ workItemId: item.id, body: "tick", author: "board-walk", authorKind: "system" });
    expect(build(lastOf("comment_added", item.id)).actor).toEqual({ raw: "board-walk", kind: "system" });
  });

  it("prUrl: the event's text first, then the latest comments newest first, then the body", () => {
    const item = store.createWorkItem({ title: "PRs", body: "see https://github.com/o/r/pull/1 and https://github.com/o/r/issues/2" });
    transitions.transition(item.id, "executing", "operator", { human: true, manual: true });
    expect(build(lastOf("status_change", item.id)).prUrl).toBe("https://github.com/o/r/pull/1");
    comments.addComment({ workItemId: item.id, body: "old https://github.com/o/r/pull/2", author: "operator", authorKind: "operator" });
    comments.addComment({ workItemId: item.id, body: "no link; issue https://github.com/o/r/issues/7", author: "operator", authorKind: "operator" });
    comments.addComment({ workItemId: item.id, body: "new https://github.com/o/r/pull/3", author: "operator", authorKind: "operator" });
    expect(build(lastOf("comment_added", item.id)).prUrl).toBe("https://github.com/o/r/pull/3");
    transitions.transition(item.id, "in_review", "operator", { detail: { note: "PR https://github.com/o/r/pull/50" } });
    expect(build(lastOf("status_change", item.id)).prUrl).toBe("https://github.com/o/r/pull/50");
    transitions.transition(item.id, "executing", "operator", { human: true });
    expect(build(lastOf("status_change", item.id)).prUrl).toBe("https://github.com/o/r/pull/3");
    expect(build(lastOf("created", store.createWorkItem({ title: "no links" }).id)).prUrl).toBeNull();
  });

  it("returns null for a Todo that no longer exists", () => {
    const item = store.createWorkItem({ title: "Gone" });
    const created = lastOf("created", item.id);
    expect(payload.buildBasePayload({ ...created, workItemId: "TSK-99999" }, "todo.created")).toBeNull();
  });
});
