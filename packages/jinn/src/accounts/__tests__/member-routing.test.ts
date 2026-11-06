import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, type Joined } from "./flows-helpers.js";
import { userCookieName } from "../cookie.js";

let h: Harness;
let pat: Joined;
beforeEach(async () => {
  h = await startHarness();
  pat = await inviteAndAccept(h, "pat@example.test");
}, 60_000);
afterEach(() => { h.close(); });

const DENIED = { error: "Not available to board members" };

describe("a member's cookie is default-deny", () => {
  const GENERAL: Array<[string, string]> = [
    ["GET", "/api/remote-mcp"], ["GET", "/api/status"], ["GET", "/api/sessions"], ["POST", "/api/sessions"],
    ["GET", "/api/config"], ["PUT", "/api/config"], ["GET", "/api/org"], ["GET", "/api/work-items"], ["POST", "/api/work-items"],
    ["GET", "/api/people"], ["POST", "/api/people/invites"], ["PATCH", "/api/people/usr_x"], ["GET", "/api/boards/ops/members"],
    ["POST", "/api/boards/ops/invites"], ["POST", "/api/account/setup"], ["POST", "/api/account/password"],
    ["GET", "/api/auth/devices"], ["POST", "/api/auth/pairing-codes"], ["POST", "/api/internal/hook"], ["GET", "/api/files"],
    ["GET", "/api/plugins/x/events"], ["GET", "/api/terminals"], ["GET", "/api/member"], ["GET", "/api/membership"],
    ["GET", "/api/member/../people"], ["POST", "/api/auth/state"], ["GET", "/api/auth/logout"], ["POST", "/api/auth/login"],
  ];
  it.each(GENERAL)("%s %s answers 403 and never reaches the general API", async (method, url) => {
    const reply = await h.request(method, url, { cookie: pat.cookie, body: method === "GET" ? undefined : {} });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual(DENIED);
  });

  it("serves static web files as to anyone, and nothing of the API", async () => {
    const reply = await h.request("GET", "/index.html", { cookie: pat.cookie });
    expect([404, 503]).toContain(reply.status);
    expect(reply.body).not.toEqual(DENIED);
  });

  it("allows exactly /api/member/*, GET /api/auth/state and POST /api/auth/logout", async () => {
    const me = await h.request("GET", "/api/member/me", { cookie: pat.cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("pat@example.test");
    for (const url of ["/api/member/todos/OPS-1", "/api/member/boards", "/api/member/nothing-here"]) {
      expect((await h.request("GET", url, { cookie: pat.cookie })).status).toBe(404);
    }
    const state = await h.request("GET", "/api/auth/state", { cookie: pat.cookie });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ authRequired: true, authenticated: false, accountsEnabled: true, principal: { kind: "member", boards: [{ department: "ops", role: "collaborator" }] } });
    expect(JSON.stringify(state.body)).not.toMatch(/token|hash/i);
  });

  it("an operator credential wins over a user cookie on the same request", async () => {
    const reply = await h.request("GET", "/api/people", { cookie: pat.cookie, authorization: "Bearer gateway-token-for-account-tests-0123456789" });
    expect(reply.status).toBe(200);
  });

  it("no cookie, no member: the 401 gate is unchanged", async () => {
    expect((await h.request("GET", "/api/people")).status).toBe(401);
    expect((await h.request("GET", "/api/member/me")).status).toBe(401);
    expect((await h.request("GET", "/api/member/me", { cookie: `${userCookieName(h.home)}=not-a-session` })).status).toBe(401);
  });

  it("logout revokes the session and clears the cookie", async () => {
    const out = await h.request("POST", "/api/auth/logout", { cookie: pat.cookie });
    expect(out.status).toBe(200);
    expect(out.cookies[0]).toMatch(/Max-Age=0/);
    expect((await h.request("GET", "/api/member/me", { cookie: pat.cookie })).status).toBe(401);
  });
});

describe("revocation applies to the next request, with no restart", () => {
  const alive = async () => (await h.request("GET", "/api/member/me", { cookie: pat.cookie })).status;

  it("disabling the user", async () => {
    expect(await alive()).toBe(200);
    await h.asOperator("PATCH", `/api/people/${pat.userId}`, { status: "disabled" });
    expect(await alive()).toBe(401);
    await h.asOperator("PATCH", `/api/people/${pat.userId}`, { status: "active" });
    expect(await alive()).toBe(401); // the session was revoked, not suspended
  });

  it("revoking one session, and all of them", async () => {
    const second = await h.request("POST", "/api/auth/login", { body: { email: "pat@example.test", password: GOOD_PASSWORD } });
    const sessions = (await h.asOperator("GET", `/api/people/${pat.userId}/sessions`)).body.sessions;
    expect(sessions).toHaveLength(2);
    const firstId = (h.db.prepare("SELECT id FROM user_sessions ORDER BY created_at, rowid LIMIT 1").get() as { id: string }).id;
    expect((await h.asOperator("DELETE", `/api/people/${pat.userId}/sessions/${firstId}`)).status).toBe(200);
    expect(await alive()).toBe(401);
    expect((await h.request("GET", "/api/member/me", { cookie: h.cookieFrom(second) })).status).toBe(200);
    await h.asOperator("DELETE", `/api/people/${pat.userId}/sessions`);
    expect((await h.request("GET", "/api/member/me", { cookie: h.cookieFrom(second) })).status).toBe(401);
  });

  it("removing a board grant shrinks what the member sees", async () => {
    await h.asOperator("POST", "/api/boards/design/invites", { email: "pat@example.test", role: "viewer" });
    expect((await h.request("GET", "/api/member/me", { cookie: pat.cookie })).body.boards.map((b: any) => b.department)).toEqual(["design", "ops"]);
    expect((await h.asOperator("DELETE", `/api/boards/ops/members/${pat.userId}`)).status).toBe(200);
    expect((await h.request("GET", "/api/member/me", { cookie: pat.cookie })).body.boards).toEqual([{ department: "design", role: "viewer" }]);
    await h.asOperator("PATCH", `/api/boards/design/members/${pat.userId}`, { role: "owner" });
    expect((await h.request("GET", "/api/auth/state", { cookie: pat.cookie })).body.principal.boards).toEqual([{ department: "design", role: "owner" }]);
  });

  it("deleting the user, and an idle or expired session", async () => {
    h.clock.now += 31 * 24 * 60 * 60 * 1000; // 30 days idle
    expect(await alive()).toBe(401);
    h.clock.now -= 31 * 24 * 60 * 60 * 1000;
    expect(await alive()).toBe(200);
    await h.asOperator("DELETE", `/api/people/${pat.userId}`);
    expect(await alive()).toBe(401);
  });

  it("a session used every few weeks still ends at 90 days", async () => {
    for (let day = 25; day <= 85; day += 25) { h.clock.now += 25 * 24 * 60 * 60 * 1000; expect(await alive()).toBe(200); }
    h.clock.now += 25 * 24 * 60 * 60 * 1000; // day 100 since sign-in
    expect(await alive()).toBe(401);
  });
});

describe("accounts need gateway auth", () => {
  it("an instance with auth off refuses accounts and ignores the user cookie", async () => {
    const off = await startHarness({ authRequired: false });
    try {
      for (const [method, url] of [["POST", "/api/auth/login"], ["POST", "/api/auth/invites/accept"], ["POST", "/api/auth/resets/complete"], ["GET", "/api/people"], ["POST", "/api/people/invites"], ["POST", "/api/account/setup"], ["POST", "/api/boards/ops/invites"]] as const) {
        const reply = await off.request(method, url, { body: method === "GET" ? undefined : { email: "a@b.test", password: GOOD_PASSWORD }, authorization: "Bearer gateway-token-for-account-tests-0123456789" });
        expect(reply.status).toBe(403);
        expect(reply.body.error).toMatch(/gateway auth/i);
      }
      // a real session row from when auth was on: the cookie is not honoured now
      const { createUser } = await import("../users.js");
      const { createUserSession } = await import("../user-sessions.js");
      const user = createUser(off.db, { email: "ghost@example.test", displayName: "Ghost", passwordHash: null, createdBy: "operator" });
      const { token } = createUserSession(off.db, { userId: user.id });
      const reply = await off.request("GET", "/api/member/me", { cookie: `${userCookieName(off.home)}=${token}` });
      expect(reply.body).not.toHaveProperty("user");
      expect(off.rt.resolvePrincipal({ headers: { cookie: `${userCookieName(off.home)}=${token}` }, socket: {} as any })).toEqual({ kind: "none" });
    } finally { off.close(); }
  });
});

describe("GET /api/auth/state", () => {
  it("with zero users renders exactly as before, apart from the new fields", async () => {
    const empty = await startHarness();
    try {
      const anon = await empty.request("GET", "/api/auth/state");
      expect(anon.body).toEqual({ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true, instance: expect.any(String), accountsEnabled: false, principal: null });
      const op = await empty.asOperator("GET", "/api/auth/state");
      expect(op.body).toMatchObject({ authenticated: true, accountsEnabled: false, principal: { kind: "operator" } });
      const { accountsEnabled: _a, principal: _p, ...before } = anon.body;
      expect(Object.keys(before).sort()).toEqual(["authRequired", "authenticated", "canBootstrapLocal", "instance", "networkExposed"]);
    } finally { empty.close(); }
  });

  it("with an account, offers the sign-in form to anonymous callers and still shows no principal", async () => {
    const anon = await h.request("GET", "/api/auth/state");
    expect(anon.body).toMatchObject({ authenticated: false, accountsEnabled: true, principal: null });
  });
});
