import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/** A session id is not a member's to hold, wherever an agent's work shows up: creators, comment authors, uploaders, relations, frames. */
let h: BoardHarness;
let viewer: Member;
let store: typeof import("../../work-items/store.js");
let todoId: string;
let childId: string;
const BARE = "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d"; // a session with no employee
let employeeSession: string; // a session whose employee is known

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  const comments = await import("../../work-items/comments.js");
  const attachments = await import("../../work-items/attachments.js");
  const relations = await import("../../work-items/relations.js");
  const { createSession } = await import("../../sessions/registry.js");
  viewer = await h.join("viewer@example.test", "viewer");
  employeeSession = createSession({ engine: "claude", source: "web", sourceRef: "t", employee: "alice" } as never).id;
  todoId = store.createWorkItem({
    title: "Made by an employee-less session", department: "ops", source: "session", sourceRef: `session:${BARE}:x`, createdBy: `session:${BARE}`,
  }).id;
  childId = store.createWorkItem({ title: "Made by alice's session", parentId: todoId, source: "session", sourceRef: `session:${employeeSession}:y`, createdBy: `session:${employeeSession}` }).id;
  comments.addComment({ workItemId: todoId, body: "from the bare session", author: `session:${BARE}`, authorKind: "employee", sessionId: BARE } as never);
  attachments.addAttachment({
    workItemId: todoId, filename: "log.txt", mime: "text/plain", stagedPath: attachments.stageAttachmentBuffer(Buffer.from("x")),
    uploader: { author: `session:${BARE}`, authorKind: "employee", operator: false },
  });
  const other = store.createWorkItem({ title: "Related", department: "ops" }).id;
  relations.addRelation(todoId, other, "relates", `session:${BARE}`);
}, 60_000);
afterAll(async () => { await h.close(); });

const noSessionIds = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(BARE);
  expect(text).not.toContain(employeeSession);
  expect(text).not.toMatch(/session:/);
};

describe("a roster employee shows by name; a name that is not on the roster is only ever 'agent'", () => {
  it("an author or creator no longer on the roster reads as agent", async () => {
    const comments = await import("../../work-items/comments.js");
    const gone = store.createWorkItem({ title: "By a departed employee", department: "ops", source: "delegation", createdBy: "departed-employee" });
    comments.addComment({ workItemId: gone.id, body: "bye", author: "departed-employee", authorKind: "employee" });
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${gone.id}`)).body;
    expect(detail.workItem.createdBy).toBe("agent");
    expect(detail.comments.comments[0].author).toBe("agent");
    expect(JSON.stringify(detail)).not.toContain("departed-employee");
  });
});

describe("members read only an employee, operator, a user or a generic agent/system: never a plugin, cron or machinery id", () => {
  it("a plugin's and a cron job's Todo and comments, and the gateway's own events", async () => {
    const comments = await import("../../work-items/comments.js");
    const plugin = store.createWorkItem({ title: "From a plugin", department: "ops", source: "connector", sourceRef: "plugin:calendar:1", createdBy: "plugin:calendar" });
    const cron = store.createWorkItem({ title: "From cron", department: "ops", source: "cron", sourceRef: "cron:nightly-sweep:2026-11-06", createdBy: "cron:nightly-sweep" });
    comments.addComment({ workItemId: plugin.id, body: "plugin says hi", author: "plugin:calendar", authorKind: "system" });
    comments.addComment({ workItemId: plugin.id, body: "walk says hi", author: "board-walk", authorKind: "system" });
    store.appendWorkItemEvent({ workItemId: cron.id, kind: "note", actor: "reconciler", detail: { note: "derived" } });
    store.appendWorkItemEvent({ workItemId: plugin.id, kind: "note", actor: "plugin:calendar", detail: { note: "plugin note" } });
    for (const id of [plugin.id, cron.id]) {
      const detail = (await h.as(viewer, "GET", `/api/member/todos/${id}`)).body;
      expect(JSON.stringify(detail)).not.toMatch(/plugin:|cron:|calendar|nightly-sweep|reconciler|board-walk/);
      expect(detail.workItem.createdBy).toBe("system");
      for (const event of detail.events) expect(["operator", "agent", "system", "connector", "cron"]).toContain(event.actor);
    }
    const page = (await h.as(viewer, "GET", `/api/member/todos/${plugin.id}/comments`)).body;
    // Whitelist, not a filter: whatever is not an employee, operator or user comes out as a generic agent or system.
    expect(page.comments.map((c: any) => c.author).sort()).toEqual(["agent", "system"]);
    const list = (await h.as(viewer, "GET", "/api/member/boards/ops/todos?limit=100")).body;
    expect(JSON.stringify(list)).not.toMatch(/plugin:|cron:|nightly-sweep/);
  });
});

describe("one member serialiser: REST and a live-update frame say the same thing", () => {
  it("the Todo a frame carries is identical to the REST detail's, with the same actor values", async () => {
    const comments = await import("../../work-items/comments.js");
    const item = store.createWorkItem({ title: "Same on both paths", department: "ops", source: "session", sourceRef: `session:${BARE}:z`, createdBy: `session:${BARE}` });
    comments.addComment({ workItemId: item.id, body: "from a plugin", author: "plugin:acme", authorKind: "system" });
    const rest = (await h.as(viewer, "GET", `/api/member/todos/${item.id}`)).body;
    const list = (await h.as(viewer, "GET", "/api/member/boards/ops/todos?limit=100")).body.workItems.find((row: any) => row.id === item.id);
    const frames: any[] = [];
    const socket = { readyState: 1, close() {}, send: (data: string) => frames.push(JSON.parse(data)) };
    h.rt.memberSockets.add(socket, viewer.sessionId);
    const live = store.getWorkItem(item.id)!;
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "created", id: item.id, version: live.version, value: live });
    h.rt.memberSockets.remove(socket);
    expect(frames).toHaveLength(1);
    // The same Todo, key for key and value for value, through REST detail and through the frame.
    expect(frames[0].payload.value).toEqual(rest.workItem);
    expect(Object.keys(frames[0].payload.value).sort()).toEqual(Object.keys(rest.workItem).sort());
    expect(rest.workItem.createdBy).toBe("agent");
    expect(list.createdBy).toBe(rest.workItem.createdBy);
    expect(rest.comments.comments.map((c: any) => c.author)).toEqual(["system"]);
    noSessionIds([rest, frames, list]);
    expect(JSON.stringify([rest, frames, list])).not.toMatch(/plugin:|acme/);
  });
});

describe("members read an agent's work without its session id", () => {
  it("the board list, detail and tree name the creator as the session's employee, or 'agent'", async () => {
    const list = (await h.as(viewer, "GET", "/api/member/boards/ops/todos?limit=100")).body;
    noSessionIds(list);
    expect(list.workItems.find((i: any) => i.id === todoId).createdBy).toBe("agent");
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todoId}`)).body;
    noSessionIds(detail);
    expect(detail.workItem.createdBy).toBe("agent");
    const tree = (await h.as(viewer, "GET", `/api/member/todos/${todoId}/tree`)).body;
    noSessionIds(tree);
    expect(tree.tree.root.children.find((c: any) => c.id === childId).createdBy).toBe("alice");
  });

  it("comments, attachments and relations too", async () => {
    const comments = (await h.as(viewer, "GET", `/api/member/todos/${todoId}/comments`)).body;
    noSessionIds(comments);
    expect(comments.comments.find((c: any) => c.body === "from the bare session").author).toBe("agent");
    const attachments = (await h.as(viewer, "GET", `/api/member/todos/${todoId}/attachments`)).body;
    noSessionIds(attachments);
    expect(attachments.attachments[0].uploadedBy).toBe("agent");
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todoId}`)).body;
    expect(detail.relations[0].createdBy).toBe("agent");
  });

  it("a socket frame's value does not carry it either", async () => {
    const frames: any[] = [];
    h.rt.memberSockets.add({ readyState: 1, close() {}, send: (data: string) => frames.push(JSON.parse(data)) }, viewer.sessionId);
    const item = store.getWorkItem(todoId)!;
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "created", id: todoId, version: item.version, value: item, sessionId: BARE });
    expect(frames).toHaveLength(1);
    noSessionIds(frames);
    expect(frames[0].payload.value.createdBy).toBe("agent");
  });
});

describe("a member's event carries only the detail keys its kind allows, each judged by value", () => {
  it("a skip-level delegation's manager-visibility note reaches a member without the child session's id", async () => {
    const { surfaceManagerVisibility } = await import("../../gateway/manager-visibility.js");
    const { createSession } = await import("../../sessions/registry.js");
    const person = (name: string, rank: string, reportsTo?: string) =>
      [name, { name, displayName: name, department: "ops", rank, engine: "claude", model: "sonnet", persona: "test", ...(reportsTo ? { reportsTo } : {}) }] as const;
    const roster = new Map([person("boss", "executive"), person("mgr", "manager", "boss"), person("ic", "employee", "mgr")]) as never;
    const todo = store.createWorkItem({ title: "Delegated past a manager", department: "ops" });
    const child = createSession({ engine: "claude", source: "web", sourceRef: "t-child", employee: "ic" } as never);
    // The real path, with its own dependencies: the manager has no live session, so the note is written on the Todo.
    surfaceManagerVisibility({ roster, employee: "ic", childSession: child, workItemId: todo.id, title: todo.title });
    const stored = store.listWorkItemEvents(todo.id).find((event) => (event.detail as any)?.managerVisibility);
    expect(JSON.stringify(stored)).toContain(child.id);
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todo.id}`)).body;
    const note = detail.events.find((event: any) => event.id === stored!.id);
    expect(note).toMatchObject({ kind: "note", detail: {} });
    expect(JSON.stringify(detail)).not.toContain(child.id);
  });

  afterEach(() => { vi.useRealTimers(); });

  // The cost secret is a sentinel no timestamp, id or counter can contain; a short number like 12.5 also reads inside "...:12.560Z".
  const COST_SENTINEL = 98765.4321;
  const SECRET_TEXT = ["/srv/private", "build-box.internal", "secret-model-x", String(COST_SENTINEL), "hidden thing"];
  const leaks = (text: string) => SECRET_TEXT.filter((value) => text.includes(value));

  it("the leak check sees a secret anywhere in the text and ignores a timestamp that reads 12.5xx", () => {
    for (const value of SECRET_TEXT) expect(leaks(`{"x":{"y":"before ${value} after"}}`)).toEqual([value]);
    expect(leaks(JSON.stringify({ updatedAt: "2026-11-06T23:09:12.560Z", n: 12.5, id: "wi_12.5" }))).toEqual([]);
  });

  const unknownKeysNeverReachAMember = async () => {
    const todo = store.createWorkItem({ title: "Unknown keys", department: "ops" });
    const secrets = { path: "/srv/private/instance/config.yaml", host: "build-box.internal", model: "secret-model-x", costUsd: COST_SENTINEL, prompt: "SYSTEM: do the hidden thing" };
    const stored = store.appendWorkItemEvent({ workItemId: todo.id, kind: "note", actor: "operator", detail: { assignee: "alice", ...secrets, nested: { ...secrets } } });
    store.appendWorkItemEvent({ workItemId: todo.id, kind: "status_change", fromStatus: "backlog", toStatus: "executing", actor: "operator", detail: { note: "started", ...secrets } });
    store.appendWorkItemEvent({ workItemId: todo.id, kind: "verify_result" as never, actor: "operator", detail: { ...secrets } });
    store.appendWorkItemEvent({ workItemId: todo.id, kind: "some_future_kind" as never, actor: "operator", detail: { ...secrets } });
    const frames: any[] = [];
    const socket = { readyState: 1, close() {}, send: (data: string) => frames.push(JSON.parse(data)) };
    h.rt.memberSockets.add(socket, viewer.sessionId);
    const live = store.getWorkItem(todo.id)!;
    h.rt.memberSockets.publish("company:changed", { entity: "todo", action: "updated", id: todo.id, version: live.version, value: live, detail: secrets });
    h.rt.memberSockets.remove(socket);
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todo.id}`)).body;
    const tree = (await h.as(viewer, "GET", `/api/member/todos/${todo.id}/tree`)).body;
    const list = (await h.as(viewer, "GET", "/api/member/boards/ops/todos?limit=200")).body;
    const text = JSON.stringify([detail, tree, list, frames]);
    expect(leaks(text)).toEqual([]);
    // Not vacuous: the secrets really were stored, so a leak would have shown.
    expect(leaks(JSON.stringify(stored))).toEqual(SECRET_TEXT);
    // What the web renders still arrives: the assignee on a note, the note on a move.
    expect(detail.events.find((event: any) => event.kind === "note").detail).toEqual({ assignee: "alice" });
    expect(detail.events.find((event: any) => event.kind === "status_change").detail).toEqual({ note: "started" });
    expect(detail.events.find((event: any) => event.kind === "some_future_kind").detail).toEqual({});
    // An event is the wire's fields and no others.
    for (const event of detail.events) expect(Object.keys(event).sort()).toEqual(["actor", "createdAt", "detail", "fromStatus", "id", "kind", "toStatus", "workItemId"]);
    return text;
  };

  it("a detail key no kind allows never reaches a member, whatever it holds, in a read or a frame", async () => {
    await unknownKeysNeverReachAMember();
  });

  it("the same holds when every timestamp reads 12.5xx seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T23:09:12.560Z"));
    const text = await unknownKeysNeverReachAMember();
    expect(text).toContain("23:09:12.560Z"); // the clock really reached the payload
  });

  it("an allowed key holding a session id, internal identity or unshared person is still dropped or generic", async () => {
    const todo = store.createWorkItem({ title: "Allowed but odd", department: "ops" });
    store.appendWorkItemEvent({
      workItemId: todo.id, kind: "status_change", fromStatus: "backlog", toStatus: "blocked", actor: "operator",
      detail: { reason: BARE, note: `session:${BARE}:x` },
    });
    store.appendWorkItemEvent({ workItemId: todo.id, kind: "label_changed", actor: "operator", detail: { labels: ["plugin:calendar", "ok-label", "cron:nightly"] } });
    store.appendWorkItemEvent({ workItemId: todo.id, kind: "note", actor: "operator", detail: { assignee: "user:usr_nobody0000" } });
    const detail = (await h.as(viewer, "GET", `/api/member/todos/${todo.id}`)).body;
    const byKind = (kind: string) => detail.events.find((event: any) => event.kind === kind).detail;
    expect(byKind("status_change")).toEqual({});
    expect(byKind("label_changed")).toEqual({ labels: ["ok-label"] });
    expect(byKind("note")).toEqual({ assignee: "member" });
    noSessionIds(detail);
    expect(JSON.stringify(detail)).not.toMatch(/plugin:|cron:|usr_nobody/);
  });
});
