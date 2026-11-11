import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, joinAsOwner } from "./flows-helpers.js";
import { authCookieName, authDeviceCookieName, createAuthSession, linkAuthSessionToUser } from "../../gateway/auth.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); }, 60_000);
afterEach(() => { h.close(); });

const state = (cookie?: string) => h.request("GET", "/api/auth/state", cookie ? { cookie } : {});

function pairedDevice(): { cookie: string; deviceId: string } {
  const paired = createAuthSession(h.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as any, { kind: "remote" });
  return { cookie: `${authCookieName(h.home)}=${paired.secret}; ${authDeviceCookieName(h.home)}=${paired.device.id}`, deviceId: paired.device.id };
}

describe("GET /api/auth/state: which account is the operator's browser", () => {
  it("carries the owner's id and display name when the device session is an active owner's", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    const reply = await state(owner.cookie);
    expect(reply.status).toBe(200);
    expect(reply.body.authenticated).toBe(true);
    expect(reply.body.principal).toEqual({ kind: "operator", user: { id: owner.userId, displayName: "Olive Owner" } });
    // Exactly the id and the name: no email, role or status leaves with it.
    expect(Object.keys(reply.body.principal.user).sort()).toEqual(["displayName", "id"]);
    expect(Object.keys(reply.body.principal).sort()).toEqual(["kind", "user"]);
  });

  it("carries it for the browser that set up its own sign-in", async () => {
    const op = pairedDevice();
    const setup = await h.request("POST", "/api/account/setup", { cookie: op.cookie, body: { email: "me@example.test", displayName: "Me", password: GOOD_PASSWORD } });
    expect(setup.status).toBe(200);
    expect((await state(op.cookie)).body.principal).toEqual({ kind: "operator", user: { id: setup.body.person.id, displayName: "Me" } });
  });

  it("carries none for a paired device, the bearer token and a request with no credentials", async () => {
    await joinAsOwner(h, "olive@example.test");
    expect((await state(pairedDevice().cookie)).body.principal).toEqual({ kind: "operator" });
    const bearer = await h.asOperator("GET", "/api/auth/state");
    expect(bearer.body.principal).toEqual({ kind: "operator" });
    expect((await state()).body.principal).toBeNull();
  });

  it("carries none once the owner is disabled or demoted, and none for a member-role link", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    // A disabled owner keeps the cookie only if something forgot to revoke it; the field must not rely on that.
    const device = pairedDevice();
    linkAuthSessionToUser(h.home, device.deviceId, owner.userId);
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(owner.userId);
    expect((await state(device.cookie)).body.principal).toEqual({ kind: "operator" });
    h.db.prepare("UPDATE users SET status = 'active', instance_role = 'member' WHERE id = ?").run(owner.userId);
    expect((await state(device.cookie)).body.principal).toEqual({ kind: "operator" });
    const member = await inviteAndAccept(h, "pat@example.test");
    const linked = pairedDevice();
    linkAuthSessionToUser(h.home, linked.deviceId, member.userId);
    expect((await state(linked.cookie)).body.principal).toEqual({ kind: "operator" });
  });

  it("carries none for a link to an account that no longer exists, and never throws on an unreadable table", async () => {
    const device = pairedDevice();
    linkAuthSessionToUser(h.home, device.deviceId, "usr_gone");
    expect((await state(device.cookie)).body.principal).toEqual({ kind: "operator" });
    const owner = await joinAsOwner(h, "olive@example.test");
    h.db.exec("ALTER TABLE users RENAME TO users_away");
    const reply = await state(owner.cookie);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ authenticated: true, hasAccounts: false, principal: { kind: "operator" } });
    expect(reply.body.principal.user).toBeUndefined();
    h.db.exec("ALTER TABLE users_away RENAME TO users");
  });

  it("leaves a member's principal as it was", async () => {
    const member = await inviteAndAccept(h, "pat@example.test");
    const reply = await state(member.cookie);
    expect(reply.body.authenticated).toBe(false);
    expect(reply.body.principal).toMatchObject({ kind: "member", user: { id: member.userId } });
  });
});
