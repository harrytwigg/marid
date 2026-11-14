import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, joinAsOwner, tokenFromLink } from "./flows-helpers.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); }, 60_000);
afterEach(() => { h.close(); });

describe("People (operator)", () => {
  it("marks the operator device the request rides on as current, and no other session", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    await h.request("POST", "/api/auth/login", { body: { email: "olive@example.test", password: GOOD_PASSWORD } });
    const own = await h.request("GET", `/api/people/${owner.userId}/sessions`, { cookie: owner.cookie });
    const devices = own.body.sessions.filter((session: any) => session.kind === "device");
    expect(devices.length).toBeGreaterThanOrEqual(2);
    expect(devices.filter((session: any) => session.current)).toHaveLength(1);
    const viaToken = await h.asOperator("GET", `/api/people/${owner.userId}/sessions`);
    expect(viaToken.body.sessions.every((session: any) => session.current === false)).toBe(true);
  });

  it("lists users with their boards and never a hash", async () => {
    await inviteAndAccept(h, "pat@example.test", { role: "owner" });
    const reply = await h.asOperator("GET", "/api/people");
    expect(reply.body.people).toHaveLength(1);
    expect(reply.body.people[0]).toMatchObject({ email: "pat@example.test", status: "active", instanceRole: "member", hasPassword: true, boards: [{ department: "ops", role: "owner" }] });
    expect(JSON.stringify(reply.body)).not.toMatch(/scrypt|password_hash|passwordHash/);
  });

  it("validates PATCH and changes display name, status and instance role", async () => {
    const { userId } = await inviteAndAccept(h, "pat@example.test");
    for (const body of [{}, { status: "gone" }, { instanceRole: "root" }, { displayName: "   " }, { displayName: "x".repeat(81) }]) {
      expect((await h.asOperator("PATCH", `/api/people/${userId}`, body)).status).toBe(400);
    }
    const ok = await h.asOperator("PATCH", `/api/people/${userId}`, { displayName: "  Patricia  ", instanceRole: "owner", status: "disabled" });
    expect(ok.body.person).toMatchObject({ displayName: "Patricia", instanceRole: "owner", status: "disabled", disabledAt: expect.any(String) });
    expect((await h.asOperator("PATCH", "/api/people/usr_000000000000", { status: "active" })).status).toBe(404);
  });

  it("promoting a member to instance owner and back takes effect on their next request, without a re-invite", async () => {
    const member = await inviteAndAccept(h, "pat@example.test", { role: "viewer" });
    expect((await h.request("GET", "/api/member/me", { cookie: member.cookie })).status).toBe(200);
    expect((await h.request("GET", "/api/people", { cookie: member.cookie })).status).not.toBe(200);
    expect((await h.asOperator("PATCH", `/api/people/${member.userId}`, { instanceRole: "owner" })).body.person.instanceRole).toBe("owner");
    // The member session ends; the next sign-in is an operator one.
    expect((await h.request("GET", "/api/member/me", { cookie: member.cookie })).status).toBe(401);
    const login = await h.request("POST", "/api/auth/login", { body: { email: "pat@example.test", password: GOOD_PASSWORD } });
    expect(login.status).toBe(200);
    const operatorCookie = h.cookieFrom(login);
    expect((await h.request("GET", "/api/people", { cookie: operatorCookie })).status).toBe(200);
    expect((await h.asOperator("PATCH", `/api/people/${member.userId}`, { instanceRole: "member" })).body.person.instanceRole).toBe("member");
    expect((await h.request("GET", "/api/people", { cookie: operatorCookie })).status).toBe(401);
    expect((await h.asOperator("GET", `/api/people/${member.userId}`)).body.person.boards).toEqual([{ department: "ops", role: "viewer" }]);
  });

  it("deleting removes the user, grants, sessions and reset links", async () => {
    const { userId } = await inviteAndAccept(h, "pat@example.test");
    await h.asOperator("POST", `/api/people/${userId}/reset-link`);
    expect((await h.asOperator("DELETE", `/api/people/${userId}`)).status).toBe(200);
    for (const table of ["users", "board_members", "user_sessions"]) expect(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM user_tokens WHERE purpose = 'reset'").get()).toEqual({ n: 0 });
  });

  it("revoking a session of someone else's id or an unknown id is 404", async () => {
    const a = await inviteAndAccept(h, "a@example.test");
    const b = await inviteAndAccept(h, "b@example.test");
    const bSession = (h.db.prepare("SELECT id FROM user_sessions WHERE user_id = ?").get(b.userId) as { id: string }).id;
    expect((await h.asOperator("DELETE", `/api/people/${a.userId}/sessions/${bSession}`)).status).toBe(404);
    expect((await h.asOperator("DELETE", `/api/people/${a.userId}/sessions/d_unknown`)).status).toBe(404);
    expect((await h.request("GET", "/api/member/me", { cookie: b.cookie })).status).toBe(200);
  });

  it("board membership: list, change role, remove", async () => {
    const { userId } = await inviteAndAccept(h, "pat@example.test", { role: "viewer" });
    await h.asOperator("POST", "/api/boards/ops/invites", { email: "later@example.test", role: "collaborator" });
    const listed = await h.asOperator("GET", "/api/boards/ops/members");
    expect(listed.body.members).toEqual([{ userId, email: "pat@example.test", displayName: "Pat Member", initials: "PM", role: "viewer" }]);
    expect(listed.body.invites.map((i: any) => i.email)).toEqual(["later@example.test"]);
    expect((await h.asOperator("PATCH", `/api/boards/ops/members/${userId}`, { role: "boss" })).status).toBe(400);
    expect((await h.asOperator("PATCH", `/api/boards/ops/members/usr_000000000000`, { role: "owner" })).status).toBe(404);
    expect((await h.asOperator("PATCH", `/api/boards/ops/members/${userId}`, { role: "owner" })).body.role).toBe("owner");
    expect((await h.asOperator("DELETE", `/api/boards/ops/members/${userId}`)).status).toBe(200);
    expect((await h.asOperator("DELETE", `/api/boards/ops/members/${userId}`)).status).toBe(404);
  });
});

describe("only the operator manages accounts", () => {
  it("the account routes refuse any caller the dispatcher does not call the operator, and never let it sign in", async () => {
    const { handleAccountsApi } = await import("../routes.js");
    const { makeReq, makeRes } = await import("./accounts-harness.js");
    const employee = { accounts: h.rt, isOperator: () => false, rejectIdentityGrant: (_r: unknown, res: any) => { res.writeHead(403, {}); res.end("{}"); return true; } };
    for (const [method, pathname] of [["GET", "/api/people"], ["PATCH", "/api/people/usr_x"], ["POST", "/api/people/invites"], ["POST", "/api/people/usr_x/reset-link"], ["DELETE", "/api/people/usr_x/sessions"], ["POST", "/api/account/setup"], ["POST", "/api/account/password"], ["GET", "/api/boards/ops/members"], ["POST", "/api/boards/ops/invites"]] as const) {
      const cap = makeRes();
      const handled = await handleAccountsApi(makeReq(method, pathname, { body: {} }), cap.res, { method, pathname, url: new URL(pathname, "http://x") }, employee);
      expect(handled).toBe(true);
      expect(cap.reply().status).toBe(403);
    }
    const login = makeRes();
    await handleAccountsApi(makeReq("POST", "/api/auth/login", { body: { email: "a@b.test", password: GOOD_PASSWORD } }), login.res, { method: "POST", pathname: "/api/auth/login", url: new URL("/api/auth/login", "http://x") }, employee);
    expect(login.reply().status).toBe(403);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get()).toEqual({ n: 0 });
  });

  it("refuses a caller whose identity headers name no real session, even holding the gateway token", async () => {
    const headers = { "x-hundredfold-caller-session": "sess-1", "x-hundredfold-tool-call": "1" };
    for (const [method, url] of [["GET", "/api/people"], ["POST", "/api/people/invites"], ["GET", "/api/boards/ops/members"], ["POST", "/api/account/setup"]] as const) {
      const reply = await h.request(method, url, { authorization: "Bearer gateway-token-for-account-tests-0123456789", headers, body: method === "GET" ? undefined : {} });
      expect(reply.status).toBe(403);
    }
    expect((await h.request("POST", "/api/auth/login", { body: { email: "a@b.test", password: GOOD_PASSWORD }, headers })).status).toBe(403);
  });

  it("an unauthenticated caller gets 401 on every operator route", async () => {
    for (const [method, url] of [["GET", "/api/people"], ["PATCH", "/api/people/usr_1"], ["POST", "/api/people/invites"], ["POST", "/api/account/setup"], ["GET", "/api/boards/ops/members"]] as const) {
      expect((await h.request(method, url, { body: method === "GET" ? undefined : {} })).status).toBe(401);
    }
  });
});

describe("set up my sign-in, and changing my own password", () => {
  async function pairedOperator() {
    const { createAuthSession, authCookieName, authDeviceCookieName } = await import("../../gateway/auth.js");
    const paired = createAuthSession(h.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as any, { kind: "remote" });
    return { cookie: `${authCookieName(h.home)}=${paired.secret}; ${authDeviceCookieName(h.home)}=${paired.device.id}`, deviceId: paired.device.id };
  }

  it("creates an owner account and links the current device, so the login screen works for them", async () => {
    const op = await pairedOperator();
    const reply = await h.request("POST", "/api/account/setup", { cookie: op.cookie, body: { email: "Me@Example.test", displayName: "Me", password: GOOD_PASSWORD } });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ linkedThisBrowser: true, person: { email: "me@example.test", instanceRole: "owner" } });
    const { listAuthSessionsForUser } = await import("../../gateway/auth.js");
    expect(listAuthSessionsForUser(h.home, reply.body.person.id).map((d) => d.id)).toEqual([op.deviceId]);
    const again = await h.request("POST", "/api/account/setup", { cookie: op.cookie, body: { email: "other@example.test", displayName: "Me", password: GOOD_PASSWORD } });
    expect(again.status).toBe(409);
    const signedIn = await h.request("POST", "/api/auth/login", { body: { email: "me@example.test", password: GOOD_PASSWORD } });
    expect(signedIn.body.principal).toEqual({ kind: "operator" });
  });

  it("validates its input and refuses a taken address", async () => {
    await inviteAndAccept(h, "pat@example.test");
    const op = await pairedOperator();
    const send = (body: unknown) => h.request("POST", "/api/account/setup", { cookie: op.cookie, body });
    expect((await send({ email: "nope", displayName: "Me", password: GOOD_PASSWORD })).status).toBe(400);
    expect((await send({ email: "me@example.test", displayName: "", password: GOOD_PASSWORD })).status).toBe(400);
    expect((await send({ email: "me@example.test", displayName: "Me", password: "short" })).status).toBe(400);
    expect((await send({ email: "pat@example.test", displayName: "Me", password: GOOD_PASSWORD })).status).toBe(409);
  });

  it("an owner changing their password needs the current one and ends their other sessions", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    const second = await h.request("POST", "/api/auth/login", { body: { email: "olive@example.test", password: GOOD_PASSWORD } });
    const wrong = await h.request("POST", "/api/account/password", { cookie: owner.cookie, body: { currentPassword: "not it at all!", newPassword: "a brand new password" } });
    expect(wrong.status).toBe(403);
    const ok = await h.request("POST", "/api/account/password", { cookie: owner.cookie, body: { currentPassword: GOOD_PASSWORD, newPassword: "a brand new password" } });
    expect(ok.status).toBe(200);
    expect((await h.request("GET", "/api/people", { cookie: owner.cookie })).status).toBe(200); // this session stays
    expect((await h.request("GET", "/api/people", { cookie: h.cookieFrom(second) })).status).toBe(401); // the other is gone
    expect((await h.request("POST", "/api/auth/login", { body: { email: "olive@example.test", password: "a brand new password" } })).status).toBe(200);
  });

  it("a paired device with no account cannot change a password", async () => {
    const op = await pairedOperator();
    const reply = await h.request("POST", "/api/account/password", { cookie: op.cookie, body: { currentPassword: GOOD_PASSWORD, newPassword: "a brand new password" } });
    expect(reply.status).toBe(403);
  });
});

describe("tokens", () => {
  it("never leave the server except as the one link", async () => {
    const invite = await h.asOperator("POST", "/api/people/invites", { email: "x@example.test", instanceRole: "member" });
    const token = tokenFromLink(invite.body.link);
    expect(JSON.stringify((await h.asOperator("GET", "/api/people/invites")).body)).not.toContain(token);
    expect(JSON.stringify(invite.body.invite)).not.toContain(token);
  });
});
