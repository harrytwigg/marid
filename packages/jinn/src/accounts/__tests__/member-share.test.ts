import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let owner: Member;
let collab: Member;
let otherOwner: Member;

beforeAll(async () => {
  h = await startBoardHarness();
  owner = await h.join("owner@example.test", "owner", "ops", "Olive Owner");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  otherOwner = await h.join("other-owner@example.test", "owner", "ops", "Otto Owner");
}, 60_000);
afterAll(async () => { await h.close(); });

describe("board owners manage their board's sharing through /api/member/boards/:department/…", () => {
  it("lists members and pending invites in the shape the operator's route answers", async () => {
    await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "later@example.test", role: "viewer" });
    const mine = await h.as(owner, "GET", "/api/member/boards/ops/members");
    const operators = await h.operator("GET", "/api/boards/ops/members");
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual(operators.body);
    expect(Object.keys(mine.body).sort()).toEqual(["invites", "members"]);
    expect(mine.body.members.map((m: any) => Object.keys(m).sort())[0]).toEqual(["displayName", "email", "initials", "role", "userId"]);
    expect(mine.body.invites[0]).toMatchObject({ email: "later@example.test", department: "ops", role: "viewer", createdBy: `user:${owner.userId}` });
  });

  it("the other roles are refused, and an unheld board is a 404", async () => {
    for (const [method, url, body] of [
      ["GET", "/api/member/boards/ops/members", undefined], ["POST", "/api/member/boards/ops/invites", { email: "x@example.test", role: "viewer" }],
      ["PATCH", `/api/member/boards/ops/members/${owner.userId}`, { role: "viewer" }], ["DELETE", `/api/member/boards/ops/members/${owner.userId}`, undefined],
      ["DELETE", "/api/member/boards/ops/invites/utk_000000000000", undefined],
    ] as const) {
      expect([url, (await h.as(collab, method, url, body)).status]).toEqual([url, 403]);
    }
    expect((await h.as(owner, "GET", "/api/member/boards/design/members")).status).toBe(404);
    expect((await h.as(owner, "POST", "/api/member/boards/design/invites", { email: "x@example.test", role: "viewer" })).status).toBe(404);
  });

  it("invite answers { link, expiresAt } for a new address and { granted: true } for an existing account", async () => {
    const fresh = await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "fresh@example.test", role: "collaborator" });
    expect(fresh.status).toBe(200);
    expect(fresh.body.link).toMatch(/\/invite#[A-Za-z0-9_-]+$/);
    expect(fresh.body.expiresAt).toEqual(expect.any(String));
    // Re-inviting the same address revokes the previous unused link.
    const again = await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "fresh@example.test", role: "viewer" });
    expect(again.body.link).not.toBe(fresh.body.link);
    expect((await h.request("POST", "/api/auth/invites/inspect", { body: { token: fresh.body.link.split("#")[1] } })).status).toBe(410);
    const design = await h.join("designer@example.test", "viewer", "design", "Dee Designer");
    const existing = await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "designer@example.test", role: "viewer" });
    expect(existing.body).toMatchObject({ granted: true });
    expect(existing.body.link).toBeUndefined();
    expect((await h.as(design, "GET", "/api/member/boards")).body.boards.map((b: any) => b.department).sort()).toEqual(["design", "ops"]);
  });

  it("an owner changes a role and removes a member, and the change applies to the member's next request", async () => {
    expect((await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "ok" })).status).toBe(201);
    expect((await h.as(owner, "PATCH", `/api/member/boards/ops/members/${collab.userId}`, { role: "viewer" })).status).toBe(200);
    expect((await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "no" })).status).toBe(403);
    expect((await h.as(owner, "DELETE", `/api/member/boards/ops/members/${collab.userId}`)).status).toBe(200);
    expect((await h.as(collab, "GET", "/api/member/boards/ops/todos")).status).toBe(404);
    expect((await h.as(owner, "PATCH", `/api/member/boards/ops/members/${collab.userId}`, { role: "viewer" })).status).toBe(404);
  });

  it("the operator changes a grant in place, viewer to collaborator to owner and back, each on the member's next request", async () => {
    const person = await h.join("stepper@example.test", "viewer", "ops", "Sasha Stepper");
    const roster = (role: string) => h.operator("PATCH", `/api/boards/ops/members/${person.userId}`, { role });
    const files = () => h.as(person, "POST", "/api/member/boards/ops/todos", { title: "stepper todo" });
    const manages = () => h.as(person, "GET", "/api/member/boards/ops/members");
    expect([(await files()).status, (await manages()).status]).toEqual([403, 403]);
    expect((await roster("collaborator")).body).toMatchObject({ status: "ok", role: "collaborator" });
    expect([(await files()).status, (await manages()).status]).toEqual([201, 403]);
    expect((await roster("owner")).status).toBe(200);
    expect([(await files()).status, (await manages()).status]).toEqual([201, 200]);
    expect((await roster("viewer")).status).toBe(200);
    expect([(await files()).status, (await manages()).status]).toEqual([403, 403]);
    // The grant changed in place: still one row, never a revoke and a new invite.
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM board_members WHERE user_id = ? AND department = 'ops'").get(person.userId)).toEqual({ n: 1 });
  });

  it("an owner cannot touch another owner, an instance owner, or grant to one; they may remove themselves", async () => {
    expect((await h.as(owner, "PATCH", `/api/member/boards/ops/members/${otherOwner.userId}`, { role: "viewer" })).status).toBe(403);
    expect((await h.as(owner, "DELETE", `/api/member/boards/ops/members/${otherOwner.userId}`)).status).toBe(403);
    expect((await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "other-owner@example.test", role: "viewer" })).status).toBe(403);
    // An instance owner on the board: made by the operator.
    const created = await h.operator("POST", "/api/people/invites", { email: "boss@example.test", instanceRole: "owner" });
    const accepted = await h.request("POST", "/api/auth/invites/accept", { body: { token: created.body.link.split("#")[1], displayName: "Boss", password: "correct horse battery staple" } });
    expect(accepted.status).toBe(200);
    const bossId = (h.db.prepare("SELECT id FROM users WHERE email = 'boss@example.test'").get() as { id: string }).id;
    await h.operator("POST", "/api/boards/ops/invites", { email: "boss@example.test", role: "collaborator" });
    expect((await h.as(owner, "PATCH", `/api/member/boards/ops/members/${bossId}`, { role: "viewer" })).status).toBe(403);
    expect((await h.as(owner, "DELETE", `/api/member/boards/ops/members/${bossId}`)).status).toBe(403);
    expect((await h.as(owner, "POST", "/api/member/boards/ops/invites", { email: "boss@example.test", role: "viewer" })).status).toBe(403);
    // Themselves, yes.
    expect((await h.as(owner, "DELETE", `/api/member/boards/ops/members/${owner.userId}`)).status).toBe(200);
    expect((await h.as(owner, "GET", "/api/member/boards/ops/members")).status).toBe(404);
  });

  it("an owner revokes a pending invite of their own board, and not one of another board", async () => {
    const invite = await h.as(otherOwner, "POST", "/api/member/boards/ops/invites", { email: "pending@example.test", role: "viewer" });
    const id = (await h.as(otherOwner, "GET", "/api/member/boards/ops/members")).body.invites.find((i: any) => i.email === "pending@example.test").id;
    expect(invite.status).toBe(200);
    const design = await h.join("d2@example.test", "owner", "design", "Dee Two");
    expect((await h.as(design, "DELETE", `/api/member/boards/design/invites/${id}`)).status).toBe(404);
    expect((await h.as(otherOwner, "DELETE", `/api/member/boards/ops/invites/${id}`)).status).toBe(200);
  });
});

describe("the member's own account routes", () => {
  it("lists and revokes only their own sessions, and changing the password ends the others", async () => {
    const second = await h.request("POST", "/api/auth/login", { body: { email: "other-owner@example.test", password: "correct horse battery staple" } });
    expect(second.status).toBe(200);
    const secondCookie = second.cookies.map((c) => c.split(";")[0]).join("; ");
    const listed = await h.as(otherOwner, "GET", "/api/member/sessions");
    expect(listed.body.sessions).toHaveLength(2);
    expect(listed.body.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(listed.body.sessions[0].kind).toBe("member");
    const stranger = await h.as(otherOwner, "DELETE", `/api/member/sessions/${(h.db.prepare("SELECT id FROM user_sessions WHERE user_id = ?").get(owner.userId) as any)?.id ?? "uss_000000000000"}`);
    expect(stranger.status).toBe(404);
    const wrong = await h.as(otherOwner, "POST", "/api/member/password", { currentPassword: "nope nope nope nope", newPassword: "a brand new long password" });
    expect(wrong.status).toBe(403);
    const changed = await h.as(otherOwner, "POST", "/api/member/password", { currentPassword: "correct horse battery staple", newPassword: "a brand new long password" });
    expect(changed.status).toBe(200);
    expect((await h.request("GET", "/api/member/me", { cookie: secondCookie })).status).toBe(401);
    expect((await h.as(otherOwner, "GET", "/api/member/me")).status).toBe(200);
    expect((await h.as(otherOwner, "POST", "/api/member/password", { currentPassword: "a brand new long password", newPassword: "short" })).status).toBe(400);
  });
});
