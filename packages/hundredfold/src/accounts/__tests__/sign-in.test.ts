import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, joinAsOwner } from "./flows-helpers.js";
import * as passwords from "../passwords.js";
import { LOGIN_MAX_PER_EMAIL, LOGIN_MAX_PER_IP } from "../login-attempts.js";
import { listAuthSessionsForUser } from "../../gateway/auth.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); }, 60_000);
afterEach(() => { vi.restoreAllMocks(); h.close(); });

const login = (email: string, password: string, ip = "198.51.100.1") =>
  h.request("POST", "/api/auth/login", { body: { email, password }, ip });

describe("member sign-in", () => {
  it("signs a member in with the namespaced user cookie, never an operator cookie", async () => {
    await inviteAndAccept(h, "pat@example.test");
    const reply = await login("PAT@example.test", GOOD_PASSWORD);
    expect(reply.status).toBe(200);
    expect(reply.body.principal).toMatchObject({ kind: "member", boards: [{ department: "ops", role: "collaborator" }] });
    expect(reply.cookies).toHaveLength(1);
    expect(reply.cookies[0]).toMatch(/^hundredfold_user_home-[\w-]+=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000$/);
    expect(JSON.stringify(h.db.prepare("SELECT * FROM user_sessions").all())).not.toContain(reply.cookies[0]!.split("=")[1]!.split(";")[0]!);
  });

  it("answers the same 401 for a wrong password, an unknown address and a disabled user", async () => {
    const { userId } = await inviteAndAccept(h, "pat@example.test");
    const wrong = await login("pat@example.test", "wrong password here");
    const unknown = await login("nobody@example.test", GOOD_PASSWORD);
    await h.asOperator("PATCH", `/api/people/${userId}`, { status: "disabled" });
    const disabled = await login("pat@example.test", GOOD_PASSWORD);
    for (const reply of [wrong, unknown, disabled]) {
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ error: "Email or password is incorrect" });
    }
  });

  it("an unknown or disabled email still takes the dummy-hash path (one hash, never skipped)", async () => {
    const { userId } = await inviteAndAccept(h, "pat@example.test");
    await h.asOperator("PATCH", `/api/people/${userId}`, { status: "disabled" });
    const run = vi.spyOn(h.rt.limiter, "run");
    await login("nobody@example.test", GOOD_PASSWORD);
    await login("pat@example.test", GOOD_PASSWORD);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockClear();
    const dummy = vi.spyOn(passwords, "verifyAgainstDummy");
    await login("nobody@example.test", GOOD_PASSWORD);
    expect(dummy).toHaveBeenCalledTimes(1);
  });
});

describe("rate limits", () => {
  it("locks an address after 5 failures, with Retry-After, checked before any hashing", async () => {
    await inviteAndAccept(h, "pat@example.test");
    for (let i = 0; i < LOGIN_MAX_PER_EMAIL; i++) expect((await login("pat@example.test", `wrong password ${i}`, `198.51.100.${i + 1}`)).status).toBe(401);
    const run = vi.spyOn(h.rt.limiter, "run");
    const locked = await login("pat@example.test", GOOD_PASSWORD, "198.51.100.200");
    expect(locked.status).toBe(429);
    expect(Number(locked.header("retry-after"))).toBeGreaterThan(0);
    expect(Number(locked.header("retry-after"))).toBeLessThanOrEqual(900);
    expect(run).not.toHaveBeenCalled(); // the correct password was never even hashed
    h.clock.now += 16 * 60 * 1000;
    expect((await login("pat@example.test", GOOD_PASSWORD, "198.51.100.200")).status).toBe(200);
  });

  it("locks an IP after 20 failures across different addresses", async () => {
    for (let i = 0; i < LOGIN_MAX_PER_IP; i++) await login(`nobody${i}@example.test`, "wrong password here", "198.51.100.9");
    const locked = await login("brand-new@example.test", "wrong password here", "198.51.100.9");
    expect(locked.status).toBe(429);
    expect((await login("brand-new@example.test", "wrong password here", "198.51.100.10")).status).toBe(401);
  });

  it("answers 429 with Retry-After when the global hashing cap is full", async () => {
    await h.close();
    const busy = { run: async () => { throw new passwords.HashBusyError(); }, stats: () => ({ running: 2, queued: 16 }) };
    h = await startHarness({ limiter: busy });
    const reply = await login("anyone@example.test", GOOD_PASSWORD);
    expect(reply.status).toBe(429);
    expect(reply.header("retry-after")).toBe("2");
  });

  it("shares the IP limit with invite inspect, accept and reset endpoints, and counts a dead token as a failure", async () => {
    for (let i = 0; i < LOGIN_MAX_PER_IP; i++) {
      expect((await h.request("POST", "/api/auth/invites/inspect", { body: { token: `not-a-real-token-${i}-xxxxxxxx` }, ip: "198.51.100.50" })).status).toBe(410);
    }
    for (const path of ["/api/auth/invites/inspect", "/api/auth/invites/accept", "/api/auth/resets/inspect", "/api/auth/resets/complete", "/api/auth/login"]) {
      expect((await h.request("POST", path, { body: { token: "x".repeat(32), email: "a@b.test", password: "p" }, ip: "198.51.100.50" })).status).toBe(429);
    }
  });
});

describe("instance owners", () => {
  it("sign in to an operator device session carrying their userId, listed on People", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    expect(owner.reply.body.principal).toEqual({ kind: "operator" });
    expect(owner.cookie).toMatch(/^hundredfold_auth\w*-?[\w-]*=.*; hundredfold_device/);
    const again = await login("olive@example.test", GOOD_PASSWORD);
    expect(again.body.principal).toEqual({ kind: "operator" });
    const devices = listAuthSessionsForUser(h.home, owner.userId);
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.kind === "password" && d.userId === owner.userId)).toBe(true);
    const sessions = await h.asOperator("GET", `/api/people/${owner.userId}/sessions`);
    expect(sessions.body.sessions.map((s: any) => s.kind)).toEqual(["device", "device"]);
    // the cookie really is an operator credential
    expect((await h.request("GET", "/api/people", { cookie: h.cookieFrom(again) })).status).toBe(200);
  });

  it("disabling revokes their device sessions at once and leaves paired devices alone", async () => {
    const { createAuthSession, authCookieName, authDeviceCookieName } = await import("../../gateway/auth.js");
    const paired = createAuthSession(h.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as any, { kind: "remote" });
    const pairedCookie = `${authCookieName(h.home)}=${paired.secret}; ${authDeviceCookieName(h.home)}=${paired.device.id}`;
    const owner = await joinAsOwner(h, "olive@example.test");
    expect((await h.request("GET", "/api/people", { cookie: owner.cookie })).status).toBe(200);
    const patched = await h.asOperator("PATCH", `/api/people/${owner.userId}`, { status: "disabled" });
    expect(patched.status).toBe(200);
    expect(listAuthSessionsForUser(h.home, owner.userId)).toHaveLength(0);
    expect((await h.request("GET", "/api/people", { cookie: owner.cookie })).status).toBe(401);
    expect((await h.request("GET", "/api/people", { cookie: pairedCookie })).status).toBe(200);
  });

  it("demoting, resetting and deleting also revoke their device sessions", async () => {
    for (const act of ["demote", "reset", "delete"] as const) {
      const email = `${act}@example.test`;
      const owner = await joinAsOwner(h, email);
      expect(listAuthSessionsForUser(h.home, owner.userId)).toHaveLength(1);
      if (act === "demote") await h.asOperator("PATCH", `/api/people/${owner.userId}`, { instanceRole: "member" });
      if (act === "delete") await h.asOperator("DELETE", `/api/people/${owner.userId}`);
      if (act === "reset") {
        const link = (await h.asOperator("POST", `/api/people/${owner.userId}/reset-link`)).body.link as string;
        const done = await h.request("POST", "/api/auth/resets/complete", { body: { token: link.split("#")[1], password: "a brand new password" } });
        expect(done.status).toBe(200);
      }
      expect(listAuthSessionsForUser(h.home, owner.userId)).toHaveLength(0);
    }
  });
});
