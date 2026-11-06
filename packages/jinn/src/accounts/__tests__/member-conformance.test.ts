import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

/**
 * "Response shapes" in docs/design/board-members.md, diffed endpoint by endpoint against the live handler: status and the
 * exact keys the document names. A response that carries more than the document says is drift too, so key sets are exact.
 */
let h: BoardHarness;
let owner: Member;
let collab: Member;
let todoId: string;
let store: typeof import("../../work-items/store.js");

const keys = (value: unknown): string[] => Object.keys(value as object).sort();

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  owner = await h.join("owner@example.test", "owner", "ops", "Olive Owner");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  todoId = (await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "Spec" })).body.workItem.id;
}, 60_000);
afterAll(async () => { await h.close(); });

describe("unauthenticated and shared", () => {
  it("GET /api/auth/state: accountsEnabled, hasAccounts and principal", async () => {
    const anon = await h.request("GET", "/api/auth/state");
    expect(anon.status).toBe(200);
    expect(anon.body).toMatchObject({ accountsEnabled: true, hasAccounts: true, principal: null });
    const member = await h.as(collab, "GET", "/api/auth/state");
    expect(member.body.principal).toEqual({
      kind: "member", user: { id: collab.userId, email: "collab@example.test", displayName: "Casey Collab" }, boards: [{ department: "ops", role: "collaborator" }],
    });
    expect((await h.operator("GET", "/api/auth/state")).body.principal).toEqual({ kind: "operator" });
  });
});

describe("operator", () => {
  it("GET /api/people → { people: [{ id, email, displayName, initials, instanceRole, status, boards, passwordSet, createdAt, lastSeenAt }] }", async () => {
    const reply = await h.operator("GET", "/api/people");
    expect(reply.status).toBe(200);
    expect(keys(reply.body)).toEqual(["people"]);
    const person = reply.body.people.find((p: any) => p.id === collab.userId);
    for (const key of ["id", "email", "displayName", "initials", "instanceRole", "status", "boards", "passwordSet", "createdAt", "lastSeenAt"]) expect(person).toHaveProperty(key);
    expect(person).toMatchObject({ initials: "CC", passwordSet: true, boards: [{ department: "ops", role: "collaborator" }] });
    expect(person.lastSeenAt === null || typeof person.lastSeenAt === "string").toBe(true);
  });

  it("GET /api/people/:id/sessions and GET /api/member/sessions → { sessions: [{ id, kind, createdAt, lastSeenAt, userAgent, ip, current }] }", async () => {
    const reply = await h.operator("GET", `/api/people/${collab.userId}/sessions`);
    expect(keys(reply.body)).toEqual(["sessions"]);
    const required = ["id", "kind", "createdAt", "lastSeenAt", "userAgent", "ip", "current"];
    const additive = ["expiresAt", "name"]; // phase 1 extras, kept
    for (const row of reply.body.sessions) {
      for (const key of required) expect(row).toHaveProperty(key);
      expect(keys(row).filter((key) => !required.includes(key) && !additive.includes(key))).toEqual([]);
      expect(typeof row.current).toBe("boolean");
    }
    expect(reply.body.sessions[0].kind).toBe("member");
    // An operator request does not ride on a member session.
    expect(reply.body.sessions.map((s: any) => s.current)).toEqual([false]);
    const second = await h.request("POST", "/api/auth/login", { body: { email: "collab@example.test", password: "correct horse battery staple" } });
    const own = await h.as(collab, "GET", "/api/member/sessions");
    for (const row of own.body.sessions) {
      for (const key of required) expect(row).toHaveProperty(key);
      expect(keys(row).filter((key) => !required.includes(key) && !additive.includes(key))).toEqual([]);
      expect(typeof row.current).toBe("boolean");
    }
    expect(own.body.sessions.filter((s: any) => s.current).map((s: any) => s.id)).toEqual([collab.sessionId]);
    expect(own.body.sessions).toHaveLength(2);
    void second;
  });

  it("POST /api/auth/invites/inspect → { email, boardName, role, instanceRole, invitedBy }; POST /api/auth/resets/inspect → { email, displayName }; 410 once used", async () => {
    const board = await h.operator("POST", "/api/boards/ops/invites", { email: "insp1@example.test", role: "viewer" });
    const inspected = await h.request("POST", "/api/auth/invites/inspect", { body: { token: board.body.link.split("#")[1] } });
    expect([inspected.status, keys(inspected.body)]).toEqual([200, ["boardName", "email", "instanceRole", "invitedBy", "role"]]);
    expect(inspected.body).toMatchObject({ boardName: "ops", role: "viewer", instanceRole: null });
    const instance = await h.operator("POST", "/api/people/invites", { email: "insp2@example.test", instanceRole: "member" });
    const instanceInspected = await h.request("POST", "/api/auth/invites/inspect", { body: { token: instance.body.link.split("#")[1] } });
    expect(instanceInspected.body).toMatchObject({ boardName: null, role: null, instanceRole: "member" });
    const reset = await h.operator("POST", `/api/people/${collab.userId}/reset-link`);
    const resetToken = reset.body.link.split("#")[1];
    const resetInspected = await h.request("POST", "/api/auth/resets/inspect", { body: { token: resetToken } });
    expect([resetInspected.status, keys(resetInspected.body)]).toEqual([200, ["displayName", "email"]]);
    await h.operator("POST", `/api/people/${collab.userId}/reset-link`); // revokes the first
    expect((await h.request("POST", "/api/auth/resets/inspect", { body: { token: resetToken } })).status).toBe(410);
    await h.operator("DELETE", `/api/people/invites/${board.body.invite.id}`);
    expect((await h.request("POST", "/api/auth/invites/inspect", { body: { token: board.body.link.split("#")[1] } })).status).toBe(410);
  });

  it("GET /api/people/invites → { invites: [{ id, email, department, role, instanceRole, createdBy, createdAt, expiresAt }] }", async () => {
    await h.operator("POST", "/api/people/invites", { email: "inst@example.test", instanceRole: "member" });
    await h.operator("POST", "/api/boards/ops/invites", { email: "brd@example.test", role: "viewer" });
    const reply = await h.operator("GET", "/api/people/invites");
    expect(keys(reply.body)).toEqual(["invites"]);
    for (const invite of reply.body.invites) expect(keys(invite)).toEqual(["createdAt", "createdBy", "department", "email", "expiresAt", "id", "instanceRole", "role"]);
    expect(reply.body.invites.find((i: any) => i.email === "inst@example.test")).toMatchObject({ department: null, role: null, instanceRole: "member" });
  });

  it("GET /api/boards/:department/members and its member mirror → { members: [{ userId, displayName, email, initials, role }], invites }", async () => {
    const operator = await h.operator("GET", "/api/boards/ops/members");
    const mirror = await h.as(owner, "GET", "/api/member/boards/ops/members");
    for (const reply of [operator, mirror]) {
      expect(reply.status).toBe(200);
      expect(keys(reply.body)).toEqual(["invites", "members"]);
      for (const member of reply.body.members) expect(keys(member)).toEqual(["displayName", "email", "initials", "role", "userId"]);
    }
    expect(mirror.body).toEqual(operator.body);
  });

  it("invite and reset-link POSTs → { link, expiresAt }; an invite to an existing active account → { granted: true }", async () => {
    const board = await h.operator("POST", "/api/boards/ops/invites", { email: "new1@example.test", role: "viewer" });
    expect(board.body).toMatchObject({ link: expect.stringContaining("/invite#"), expiresAt: expect.any(String) });
    const memberInvite = await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "new2@example.test", role: "viewer" });
    expect(memberInvite.body).toMatchObject({ link: expect.stringContaining("/invite#"), expiresAt: expect.any(String) });
    const instance = await h.operator("POST", "/api/people/invites", { email: "new3@example.test", instanceRole: "member" });
    expect(instance.body).toMatchObject({ link: expect.stringContaining("/invite#"), expiresAt: expect.any(String) });
    const reset = await h.operator("POST", `/api/people/${collab.userId}/reset-link`);
    expect(keys(reset.body)).toEqual(["expiresAt", "link"]);
    expect(reset.body.link).toContain("/reset#");
    const existing = await h.operator("POST", "/api/boards/design/invites", { email: "collab@example.test", role: "viewer" });
    expect(existing.body.granted).toBe(true);
    expect(existing.body.link).toBeUndefined();
  });
});

describe("member", () => {
  it("GET /api/member/me → { user: { id, email, displayName }, boards: [{ department, role }] }", async () => {
    const reply = await h.as(collab, "GET", "/api/member/me");
    expect(keys(reply.body)).toEqual(["boards", "user"]);
    expect(keys(reply.body.user)).toEqual(["displayName", "email", "id"]);
    expect(reply.body.boards.map(keys)).toEqual([["department", "role"], ["department", "role"]].slice(0, reply.body.boards.length));
  });

  it("GET /api/member/boards → { boards: [{ department, role, prefix, displayName? }] }", async () => {
    const reply = await h.as(owner, "GET", "/api/member/boards");
    expect(keys(reply.body)).toEqual(["boards"]);
    expect(reply.body.boards[0]).toEqual({ department: "ops", role: "owner", prefix: "OPS" });
  });

  it("GET /api/member/people → { people: [{ id, displayName, initials }], employees: [{ name, displayName, emoji }] }", async () => {
    const reply = await h.as(owner, "GET", "/api/member/people");
    expect(keys(reply.body)).toEqual(["employees", "people"]);
    for (const person of reply.body.people) expect(keys(person)).toEqual(["displayName", "id", "initials"]);
  });

  it("PATCH /api/member/todos/:id → { workItem, replayed }", async () => {
    const reply = await h.as(collab, "PATCH", `/api/member/todos/${todoId}`, { title: "Spec 2", expectedVersion: store.getWorkItem(todoId)!.version });
    expect([reply.status, keys(reply.body)]).toEqual([200, ["replayed", "workItem"]]);
  });

  it("POST /api/member/todos/:id/status → { workItem, escalated: false }", async () => {
    const reply = await h.as(collab, "POST", `/api/member/todos/${todoId}/status`, { status: "done" });
    expect([reply.status, keys(reply.body), reply.body.escalated]).toEqual([200, ["escalated", "workItem"], false]);
    await h.as(collab, "POST", `/api/member/todos/${todoId}/status`, { status: "backlog" });
  });

  it("POST /api/member/todos/:id/comments { body, parentCommentId? } → { comment }", async () => {
    const reply = await h.as(collab, "POST", `/api/member/todos/${todoId}/comments`, { body: "hi" });
    expect([reply.status, keys(reply.body)]).toEqual([201, ["comment"]]);
  });

  it("GET /api/member/todos/:id → the operator's detail shape, comments and events included, minus session fields", async () => {
    const member = await h.as(collab, "GET", `/api/member/todos/${todoId}`);
    const operator = await h.operator("GET", `/api/work-items/${todoId}`);
    expect(member.status).toBe(200);
    // `members` is additive and only present when the Todo names a member, which this one does.
    // Session and run fields are removed for members, and every cost figure is null.
    expect(keys(member.body).filter((key) => key !== "members")).toEqual(keys(operator.body).filter((key) => !["members", "runs", "dispatchConfig"].includes(key)));
    expect(member.body.spendUsd).toBeNull();
    expect((await h.as(collab, "GET", `/api/member/todos/${todoId}/tree`)).body.tree.spendUsd).toBeNull();
    expect(JSON.stringify(member.body)).not.toMatch(/sessionId|session:/);
  });

  it("GET /api/member/boards/:department/todos has the operator list's query shape and item serialisation", async () => {
    const member = await h.as(collab, "GET", "/api/member/boards/ops/todos?limit=5&status=backlog");
    const operator = await h.operator("GET", "/api/work-items?department=ops&limit=5&status=backlog");
    expect(keys(member.body)).toEqual(keys(operator.body));
    expect(keys(member.body.workItems[0])).toEqual(keys(operator.body.workItems[0]));
  });

  it("member reads keep the pinned wrappers, with every cost figure null and no session or run field", async () => {
    const list = (await h.as(collab, "GET", "/api/member/boards/ops/todos")).body;
    for (const key of ["workItems", "total", "nextOffset", "totals"]) expect(list).toHaveProperty(key);
    const tree = (await h.as(collab, "GET", `/api/member/todos/${todoId}/tree`)).body;
    expect(keys(tree)).toEqual(["tree"]);
    expect(keys(tree.tree)).toEqual(["root", "spendUsd", "totals"]);
    expect(tree.tree.spendUsd).toBeNull();
    const detail = (await h.as(collab, "GET", `/api/member/todos/${todoId}`)).body;
    for (const key of ["workItem", "spendUsd", "events", "comments"]) expect(detail).toHaveProperty(key);
    expect(detail.spendUsd).toBeNull();
    expect(detail.workItem.budgetUsd).toBeNull();
    // No cost figure anywhere is a number: spend and budget fields are null wherever they appear.
    const costs: unknown[] = [];
    JSON.stringify([list, tree, detail], (key, value) => { if (/usd$/i.test(key)) costs.push(value); return value; });
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((value) => value === null)).toBe(true);
    expect(JSON.stringify([list, tree, detail])).not.toMatch(/"(runs|dispatchConfig|sessionId|sessionRef)":(?!null)/);
  });

  it("the Todo's tree, comments and attachments answer the operator's shapes", async () => {
    const tree = await h.as(collab, "GET", `/api/member/todos/${todoId}/tree`);
    expect(keys(tree.body.tree)).toEqual(keys((await h.operator("GET", `/api/work-items/${todoId}/tree`)).body.tree));
    const list = await h.as(collab, "GET", `/api/member/todos/${todoId}/comments`);
    expect(keys(list.body)).toEqual(keys((await h.operator("GET", `/api/work-items/${todoId}/comments`)).body));
    expect(keys((await h.as(collab, "GET", `/api/member/todos/${todoId}/attachments`)).body)).toEqual(["attachments"]);
  });

  it("PATCH/DELETE /api/member/todos/:id/comments/:cid → { comment }; sessions routes → { sessions }", async () => {
    const comment = (await h.as(collab, "POST", `/api/member/todos/${todoId}/comments`, { body: "x" })).body.comment;
    expect(keys((await h.as(collab, "PATCH", `/api/member/todos/${todoId}/comments/${comment.id}`, { body: "y" })).body)).toEqual(["comment"]);
    expect(keys((await h.as(collab, "DELETE", `/api/member/todos/${todoId}/comments/${comment.id}`)).body)).toEqual(["comment"]);
    expect(keys((await h.as(collab, "GET", "/api/member/sessions")).body)).toEqual(["sessions"]);
  });
});
