import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness, type HarnessOptions } from "./accounts-harness.js";
import { inviteAndAccept, joinAsOwner } from "./flows-helpers.js";
import { LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS, RECENT_SUCCESS_MS, reserveAttempt } from "../login-attempts.js";
import { logger } from "../../shared/logger.js";

vi.setConfig({ testTimeout: 60_000 });
let h: Harness | undefined;
afterEach(() => { vi.restoreAllMocks(); h?.close(); h = undefined; });

const DAY = 24 * 60 * 60 * 1000;
const LOOPBACK_PROXY = { trustedProxies: ["127.0.0.1", "::1"] };

async function start(opts: HarnessOptions): Promise<Harness> {
  h = await startHarness(opts);
  return h;
}

/** A sign-in the way a local reverse proxy forwards it: from the proxy's socket, naming the client in X-Forwarded-For. */
const viaProxy = (email: string, password: string, client: string | undefined, peer = "127.0.0.1") =>
  h!.request("POST", "/api/auth/login", { body: { email, password }, ip: peer, ...(client ? { headers: { "x-forwarded-for": client } } : {}) });
const rows = (prefix: string) => (h!.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email_or_ip LIKE ?").get(`${prefix}%`) as { n: number }).n;
const wrong = "wrong password here";

/** Fail `n` sign-ins for unknown emails from `n` distinct client addresses behind the proxy. */
async function spray(n: number, prefix = "203.0.113."): Promise<void> {
  for (let i = 0; i < n; i++) expect((await viaProxy(`nobody${i}@example.test`, wrong, `${prefix}${i + 1}`)).status).toBe(401);
}

describe("per-IP limit behind a trusted proxy", () => {
  it("counts the forwarded client, not the proxy: spraying emails from one address answers 429 at the 21st", async () => {
    await start(LOOPBACK_PROXY);
    for (let i = 0; i < LOGIN_MAX_PER_IP; i++) expect((await viaProxy(`nobody${i}@example.test`, wrong, "198.51.100.9")).status).toBe(401);
    const locked = await viaProxy("another@example.test", wrong, "198.51.100.9");
    expect(locked.status).toBe(429);
    expect(Number(locked.header("retry-after"))).toBeGreaterThan(0);
    expect((await viaProxy("another@example.test", wrong, "198.51.100.10")).status).toBe(401); // somebody else is not locked out
    expect(rows("ip:198.51.100.9")).toBe(LOGIN_MAX_PER_IP);
    expect(rows("ip:127.0.0.1")).toBe(0);
  });

  it("ignores a spoofed X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    await start(LOOPBACK_PROXY);
    for (let i = 0; i < LOGIN_MAX_PER_IP; i++) await viaProxy(`nobody${i}@example.test`, wrong, `198.51.100.${i + 1}`, "203.0.113.50");
    const locked = await viaProxy("another@example.test", wrong, "198.51.100.200", "203.0.113.50");
    expect(locked.status).toBe(429); // one bucket for the real peer, however many addresses it claims
    expect(rows("ip:203.0.113.50")).toBe(LOGIN_MAX_PER_IP);
  });

  it("uses clientIpHeader instead of X-Forwarded-For when it is set", async () => {
    await start({ ...LOOPBACK_PROXY, clientIpHeader: "cf-connecting-ip" });
    for (let i = 0; i < LOGIN_MAX_PER_IP; i++) {
      await h!.request("POST", "/api/auth/login", { body: { email: `nobody${i}@example.test`, password: wrong }, ip: "127.0.0.1", headers: { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": `6.6.6.${i + 1}` } });
    }
    const locked = await h!.request("POST", "/api/auth/login", { body: { email: "x@example.test", password: wrong }, ip: "127.0.0.1", headers: { "cf-connecting-ip": "198.51.100.9" } });
    expect(locked.status).toBe(429);
    expect(rows("ip:6.6.6")).toBe(0);
  });

  it("follows config.yaml reloads: trust added or removed applies to the next request", async () => {
    await start({});
    await viaProxy("a@example.test", wrong, "198.51.100.9");
    expect(rows("ip:")).toBe(0); // no config: a loopback peer gets no IP bucket
    h!.config.gateway.trustedProxies = ["127.0.0.1"];
    await viaProxy("a@example.test", wrong, "198.51.100.9");
    expect(rows("ip:198.51.100.9")).toBe(1);
    h!.config.gateway.trustedProxies = [];
    await viaProxy("a@example.test", wrong, "198.51.100.9");
    expect(rows("ip:")).toBe(1);
  });
});

describe("with no trusted proxies configured", () => {
  it("gives a loopback peer no IP bucket and no exemption, whatever X-Forwarded-For claims", async () => {
    await start({ loginBudgetMax: 30 });
    const { userId } = await inviteAndAccept(h!, "pat@example.test");
    for (let i = 0; i < LOGIN_MAX_PER_IP + 5; i++) expect((await viaProxy(`nobody${i}@example.test`, wrong, `198.51.100.${i + 1}`)).status).toBe(401);
    expect(rows("ip:")).toBe(0);
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.77")).status).toBe(200);
    expect(rows("ok:127")).toBe(0); // a loopback address stands for everyone behind the tunnel
    expect(rows("ok:198.51.100")).toBe(0); // and the header it carried was never believed
    h!.db.prepare("DELETE FROM login_attempts").run();
    reserveAttempt(h!.db, { ip: undefined, instance: true }, h!.clock.now); // fill to the budget
    for (let i = 1; i < 30; i++) reserveAttempt(h!.db, { ip: undefined, instance: true }, h!.clock.now);
    const before = userSessionsFor(userId);
    const refused = await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.77");
    expect(refused.status).toBe(429);
    expect(userSessionsFor(userId)).toBe(before);
  });

  it("keeps the socket address as the bucket for a public peer, headers or not", async () => {
    await start({});
    for (let i = 0; i < LOGIN_MAX_PER_IP; i++) await viaProxy(`nobody${i}@example.test`, wrong, `198.51.100.${i + 1}`, "203.0.113.50");
    expect((await viaProxy("x@example.test", wrong, "198.51.100.250", "203.0.113.50")).status).toBe(429);
  });

  it("records the socket peer on a member session, as before", async () => {
    await start({});
    await inviteAndAccept(h!, "pat@example.test");
    await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.1", "127.0.0.1");
    expect(h!.db.prepare("SELECT ip FROM user_sessions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ ip: "127.0.0.1" });
  });
});

const userSessionsFor = (userId: string) => (h!.db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?").get(userId) as { n: number }).n;

describe("instance-wide failure budget", () => {
  it("answers 429 with Retry-After once failures from many addresses reach the budget, before any hashing", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 6 });
    await spray(6);
    const run = vi.spyOn(h!.rt.limiter, "run");
    const started = h!.clock.now;
    h!.clock.now += 60_000;
    const refused = await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.200");
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: "Too many attempts, try again later" });
    expect(Number(refused.header("retry-after"))).toBe(Math.ceil((started + LOGIN_WINDOW_MS - h!.clock.now) / 1000));
    expect(run).not.toHaveBeenCalled();
    expect(rows("instance:")).toBe(6); // a refusal is never counted
    expect(rows("ip:198.51.100.200")).toBe(0);
    h!.clock.now = started + LOGIN_WINDOW_MS + 1000;
    expect((await viaProxy("pat@example.test", wrong, "198.51.100.200")).status).toBe(401); // the window passed
  });

  it("defaults to 100 failures per 15 minutes", async () => {
    await start(LOOPBACK_PROXY);
    for (let i = 0; i < 99; i++) reserveAttempt(h!.db, { ip: undefined, instance: true }, h!.clock.now);
    expect((await viaProxy("a@example.test", wrong, "198.51.100.1")).status).toBe(401); // the 100th
    expect((await viaProxy("b@example.test", wrong, "198.51.100.2")).status).toBe(429);
  });

  it("lets an address with a recent success in over budget, and refuses a stranger with the right password", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 6 });
    const { userId } = await inviteAndAccept(h!, "pat@example.test");
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.1")).status).toBe(200);
    expect(rows("ok:198.51.100.1")).toBe(1);
    expect(rows("instance:")).toBe(0); // a success gives its reservation back
    await spray(6);
    const before = userSessionsFor(userId);
    const stranger = await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.99");
    expect(stranger.status).toBe(429);
    expect(stranger.cookies).toEqual([]);
    expect(userSessionsFor(userId)).toBe(before); // no session minted
    expect((await viaProxy("pat@example.test", wrong, "198.51.100.1")).status).toBe(401); // known address: still checked, not refused
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.1")).status).toBe(200);
    expect(userSessionsFor(userId)).toBe(before + 1);
  });

  it("counts accepting an invite as a sign-in: that address is let in over budget afterwards", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 3 });
    const invite = await h!.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "collaborator" });
    const accepted = await h!.request("POST", "/api/auth/invites/accept", {
      body: { token: invite.body.link.split("#")[1], displayName: "Pat", password: GOOD_PASSWORD }, ip: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.70" },
    });
    expect(accepted.status).toBe(200);
    expect(rows("ok:198.51.100.70")).toBe(1);
    await spray(3);
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.71")).status).toBe(429);
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.70")).status).toBe(200);
  });

  it("keeps the exemption for 30 days, not longer, and only for that address", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 3 });
    await inviteAndAccept(h!, "pat@example.test");
    await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.1");
    h!.clock.now += RECENT_SUCCESS_MS - DAY;
    await spray(3);
    // A wrong password is answered 401 (let in, then checked) rather than 429; it does not renew the success.
    expect((await viaProxy("pat@example.test", wrong, "198.51.100.1")).status).toBe(401);
    expect((await viaProxy("pat@example.test", wrong, "198.51.100.2")).status).toBe(429);
    h!.clock.now += 2 * DAY; // 31 days after the success; the window has long passed, so fill it again
    await spray(3, "203.0.114.");
    expect((await viaProxy("pat@example.test", wrong, "198.51.100.1")).status).toBe(429);
  });

  it("never exempts a shared address: a trusted proxy that named no client", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 3 });
    await inviteAndAccept(h!, "pat@example.test");
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, undefined)).status).toBe(200);
    expect(rows("ok:127")).toBe(0); // the proxy itself is never remembered
    await spray(3);
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, undefined)).status).toBe(429);
  });

  it("does not budget invites or resets", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 2 });
    await spray(2);
    expect((await viaProxy("x@example.test", "x", "198.51.100.99")).status).toBe(429); // the budget is spent
    for (const path of ["/api/auth/invites/inspect", "/api/auth/resets/inspect"]) {
      const reply = await h!.request("POST", path, { body: { token: "x".repeat(32) }, ip: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.98" } });
      expect(reply.status).toBe(410);
    }
  });

  it("warns once per window, without an address or email in the line", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 2 });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await spray(2);
    for (let i = 0; i < 4; i++) expect((await viaProxy(`victim${i}@example.test`, wrong, `198.51.100.${200 + i}`)).status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toMatch(/budget reached.*unrecognised addresses are refused until \d{4}-\d\d-\d\dT/i);
    expect(line).not.toMatch(/198\.51|203\.0|example\.test|victim/);
    h!.clock.now += LOGIN_WINDOW_MS + 1000;
    await spray(2, "203.0.115.");
    await viaProxy("victim@example.test", wrong, "198.51.100.250");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("credentials the budget never touches", () => {
  it("a paired device, the bearer token, an owner's session and a member's cookie all keep working over budget", async () => {
    await start({ ...LOOPBACK_PROXY, loginBudgetMax: 3 });
    const member = await inviteAndAccept(h!, "pat@example.test");
    const owner = await joinAsOwner(h!, "olive@example.test");
    const { createAuthSession, authCookieName, authDeviceCookieName } = await import("../../gateway/auth.js");
    const paired = createAuthSession(h!.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as never, { kind: "remote" });
    const pairedCookie = `${authCookieName(h!.home)}=${paired.secret}; ${authDeviceCookieName(h!.home)}=${paired.device.id}`;
    await spray(3);
    expect((await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.99")).status).toBe(429); // the budget is spent
    expect((await h!.request("GET", "/api/people", { cookie: pairedCookie })).status).toBe(200);
    expect((await h!.asOperator("GET", "/api/people")).status).toBe(200);
    expect((await h!.request("GET", "/api/people", { cookie: owner.cookie })).status).toBe(200);
    expect((await h!.request("GET", "/api/member/me", { cookie: member.cookie })).status).toBe(200);
  });
});

describe("the address a member session records", () => {
  it("is the forwarded client behind a trusted proxy", async () => {
    await start(LOOPBACK_PROXY);
    await inviteAndAccept(h!, "pat@example.test");
    await viaProxy("pat@example.test", GOOD_PASSWORD, "198.51.100.1");
    expect(h!.db.prepare("SELECT ip FROM user_sessions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ ip: "198.51.100.1" });
  });
});
