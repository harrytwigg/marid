import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, tokenFromLink } from "./flows-helpers.js";
import { userCookieName } from "../cookie.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); }, 60_000);
afterEach(() => { h.close(); });

const DAY = 24 * 60 * 60 * 1000;

describe("invite to a board", () => {
  it("returns the link once, as a fragment, and stores only a hash", async () => {
    const reply = await h.asOperator("POST", "/api/boards/ops/invites", { email: "Pat@Example.test", role: "viewer" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ granted: false, invite: { email: "pat@example.test", department: "ops", role: "viewer" } });
    expect(reply.body.link).toMatch(/^http:\/\/gateway\.test\/invite#[\w-]{43}$/);
    const token = tokenFromLink(reply.body.link);
    const rows = h.db.prepare("SELECT * FROM user_tokens").all() as Array<Record<string, string>>;
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(rows[0]!.expires_at) - Date.parse(rows[0]!.created_at)).toBe(7 * DAY);
    const listed = await h.asOperator("GET", "/api/boards/ops/members");
    expect(listed.body.invites).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(token);
  });

  it("re-inviting the same address to the same board revokes the previous link", async () => {
    const first = await h.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "viewer" });
    await h.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "collaborator" });
    const dead = await h.request("POST", "/api/auth/invites/inspect", { body: { token: tokenFromLink(first.body.link) } });
    expect(dead.status).toBe(410);
    expect((await h.asOperator("GET", "/api/people/invites")).body.invites).toHaveLength(1);
  });

  it("inspect shows the invite; accept creates user, grant and session together and uses the token up", async () => {
    const invite = await h.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "collaborator" });
    const token = tokenFromLink(invite.body.link);
    const seen = await h.request("POST", "/api/auth/invites/inspect", { body: { token } });
    expect(seen.body).toEqual({ email: "pat@example.test", boardName: "ops", role: "collaborator", instanceRole: null, invitedBy: "Operator" });

    expect((await h.request("POST", "/api/auth/invites/accept", { body: { token, displayName: "Pat", password: "short" } })).status).toBe(400);
    const accepted = await h.request("POST", "/api/auth/invites/accept", { body: { token, displayName: "Pat", password: GOOD_PASSWORD } });
    expect(accepted.status).toBe(200);
    expect(accepted.cookies[0]).toContain(userCookieName(h.home));
    const me = await h.request("GET", "/api/member/me", { cookie: h.cookieFrom(accepted) });
    expect(me.body).toEqual({ user: { id: expect.stringMatching(/^usr_[0-9a-f]{12}$/), email: "pat@example.test", displayName: "Pat" }, boards: [{ department: "ops", role: "collaborator" }] });
    expect((await h.request("POST", "/api/auth/invites/inspect", { body: { token } })).status).toBe(410);
    expect((await h.request("POST", "/api/auth/invites/accept", { body: { token, displayName: "Pat", password: GOOD_PASSWORD } })).status).toBe(410);
  });

  it("an expired link is 410 and no password is hashed for it", async () => {
    const invite = await h.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "viewer" });
    h.clock.now += 8 * DAY;
    const reply = await h.request("POST", "/api/auth/invites/accept", { body: { token: tokenFromLink(invite.body.link), displayName: "Pat", password: GOOD_PASSWORD } });
    expect(reply.status).toBe(410);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("an existing active account is granted straight away, no link", async () => {
    await inviteAndAccept(h, "pat@example.test", { department: "ops" });
    const reply = await h.asOperator("POST", "/api/boards/design/invites", { email: "PAT@example.test", role: "viewer" });
    expect(reply.body).toMatchObject({ granted: true, role: "viewer" });
    expect(reply.body.link).toBeUndefined();
    const members = await h.asOperator("GET", "/api/boards/design/members");
    expect(members.body.members).toHaveLength(1);
  });

  it("revoking a pending invite kills the link", async () => {
    const invite = await h.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "viewer" });
    const id = invite.body.invite.id;
    expect((await h.asOperator("DELETE", `/api/boards/design/invites/${id}`)).status).toBe(404); // wrong board
    expect((await h.asOperator("DELETE", `/api/boards/ops/invites/${id}`)).status).toBe(200);
    expect((await h.request("POST", "/api/auth/invites/inspect", { body: { token: tokenFromLink(invite.body.link) } })).status).toBe(410);
  });

  it("refuses an unknown board, a bad role and a bad email", async () => {
    expect((await h.asOperator("POST", "/api/boards/nowhere/invites", { email: "a@b.test", role: "viewer" })).status).toBe(404);
    expect((await h.asOperator("POST", "/api/boards/ops/invites", { email: "a@b.test", role: "admin" })).status).toBe(400);
    expect((await h.asOperator("POST", "/api/boards/ops/invites", { email: "nope", role: "viewer" })).status).toBe(400);
  });
});

describe("instance invites and owner invites", () => {
  it("an owner invite lasts 24 hours, a member instance invite 7 days, and neither carries a board", async () => {
    await h.asOperator("POST", "/api/people/invites", { email: "owner@example.test", instanceRole: "owner" });
    await h.asOperator("POST", "/api/people/invites", { email: "plain@example.test", instanceRole: "member" });
    const rows = h.db.prepare("SELECT email, department, expires_at, created_at FROM user_tokens ORDER BY email").all() as any[];
    expect(rows.map((r) => [r.email, r.department, Date.parse(r.expires_at) - Date.parse(r.created_at)])).toEqual([
      ["owner@example.test", null, DAY], ["plain@example.test", null, 7 * DAY],
    ]);
    const listed = (await h.asOperator("GET", "/api/people/invites")).body.invites;
    expect(listed.map((i: any) => i.instanceRole).sort()).toEqual(["member", "owner"]);
  });

  it("a member instance invite makes a board-less user who signs in and sees no boards", async () => {
    const invite = await h.asOperator("POST", "/api/people/invites", { email: "plain@example.test", instanceRole: "member" });
    const accepted = await h.request("POST", "/api/auth/invites/accept", { body: { token: tokenFromLink(invite.body.link), displayName: "Plain", password: GOOD_PASSWORD } });
    const me = await h.request("GET", "/api/member/me", { cookie: h.cookieFrom(accepted) });
    expect(me.body.boards).toEqual([]);
  });

  it("refuses an instance invite for an address that already has an account", async () => {
    await inviteAndAccept(h, "pat@example.test");
    expect((await h.asOperator("POST", "/api/people/invites", { email: "pat@example.test", instanceRole: "owner" })).status).toBe(409);
  });
});

describe("password reset", () => {
  it("a reset link sets a new password and revokes the user's sessions; the old password stops working", async () => {
    const { cookie, userId } = await inviteAndAccept(h, "pat@example.test");
    const link = (await h.asOperator("POST", `/api/people/${userId}/reset-link`)).body.link as string;
    expect(link).toMatch(/\/reset#/);
    const token = link.split("#")[1];
    expect((await h.request("POST", "/api/auth/resets/inspect", { body: { token } })).body).toEqual({ email: "pat@example.test", displayName: "Pat Member" });
    expect((await h.request("POST", "/api/auth/resets/complete", { body: { token, password: "tiny" } })).status).toBe(400);
    expect((await h.request("POST", "/api/auth/resets/complete", { body: { token, password: "an entirely new password" } })).status).toBe(200);
    expect((await h.request("GET", "/api/member/me", { cookie })).status).toBe(401);
    expect((await h.request("POST", "/api/auth/login", { body: { email: "pat@example.test", password: GOOD_PASSWORD } })).status).toBe(401);
    expect((await h.request("POST", "/api/auth/login", { body: { email: "pat@example.test", password: "an entirely new password" } })).status).toBe(200);
    expect((await h.request("POST", "/api/auth/resets/complete", { body: { token, password: "yet another password" } })).status).toBe(410);
  });

  it("a newer reset link replaces the older one, and a disabled user's link is dead", async () => {
    const { userId } = await inviteAndAccept(h, "pat@example.test");
    const first = (await h.asOperator("POST", `/api/people/${userId}/reset-link`)).body.link as string;
    const second = (await h.asOperator("POST", `/api/people/${userId}/reset-link`)).body.link as string;
    expect((await h.request("POST", "/api/auth/resets/inspect", { body: { token: first.split("#")[1] } })).status).toBe(410);
    await h.asOperator("PATCH", `/api/people/${userId}`, { status: "disabled" });
    expect((await h.request("POST", "/api/auth/resets/inspect", { body: { token: second.split("#")[1] } })).status).toBe(410);
  });
});
