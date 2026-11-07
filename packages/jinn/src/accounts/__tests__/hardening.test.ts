import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_PASSWORD, startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, joinAsOwner, tokenFromLink } from "./flows-helpers.js";
import { createHashLimiter, HashBusyError, type HashLimiter } from "../passwords.js";
import { LOGIN_MAX_PER_EMAIL } from "../login-attempts.js";
import { listAuthSessionsForUser } from "../../gateway/auth.js";
import { createUser } from "../users.js";

/** A real limiter that runs `afterHash` once, right after the next hash resolves: the moment sign-in used to trust a stale user. */
function limiterWithHook(): HashLimiter & { afterHash: (() => Promise<unknown>) | null } {
  const real = createHashLimiter();
  const wrapped = {
    afterHash: null as (() => Promise<unknown>) | null,
    stats: () => real.stats(),
    async run<T>(task: () => Promise<T>): Promise<T> {
      const result = await real.run(task);
      const hook = wrapped.afterHash;
      wrapped.afterHash = null; // the hook's own requests must not trigger it again
      if (hook) await hook();
      return result;
    },
  };
  return wrapped;
}

let h: Harness;
let limiter: ReturnType<typeof limiterWithHook>;
beforeEach(async () => {
  limiter = limiterWithHook();
  h = await startHarness({ limiter });
}, 60_000);
afterEach(() => { h.close(); });

const login = (email: string, password = GOOD_PASSWORD, ip = "198.51.100.1") =>
  h.request("POST", "/api/auth/login", { body: { email, password }, ip });
const memberSessions = (userId: string) => (h.db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { n: number }).n;

describe("a user who changes while their password is being checked gets no session", () => {
  it("an owner disabled during sign-in", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    limiter.afterHash = () => h.asOperator("PATCH", `/api/people/${owner.userId}`, { status: "disabled" });
    const reply = await login("olive@example.test");
    expect(reply.status).toBe(401);
    expect(reply.cookies).toEqual([]);
    expect(listAuthSessionsForUser(h.home, owner.userId)).toHaveLength(0);
  });

  it("an owner demoted during sign-in", async () => {
    const owner = await joinAsOwner(h, "olive@example.test");
    limiter.afterHash = () => h.asOperator("PATCH", `/api/people/${owner.userId}`, { instanceRole: "member" });
    const reply = await login("olive@example.test");
    expect(reply.status).toBe(401);
    expect(listAuthSessionsForUser(h.home, owner.userId)).toHaveLength(0);
    expect(memberSessions(owner.userId)).toBe(0);
  });

  it("a member whose password is reset during sign-in", async () => {
    const pat = await inviteAndAccept(h, "pat@example.test");
    const link = (await h.asOperator("POST", `/api/people/${pat.userId}/reset-link`)).body.link as string;
    limiter.afterHash = () => h.request("POST", "/api/auth/resets/complete", { body: { token: tokenFromLink(link), password: "an entirely new password" } });
    const reply = await login("pat@example.test");
    expect(reply.status).toBe(401);
    expect(reply.cookies).toEqual([]);
    expect(memberSessions(pat.userId)).toBe(0);
  });
});

describe("the per-address limit holds under concurrency", () => {
  it("lets exactly 5 of 16 simultaneous wrong guesses reach the hash", async () => {
    await inviteAndAccept(h, "pat@example.test");
    const replies = await Promise.all(Array.from({ length: 16 }, (_, i) => login("pat@example.test", `wrong password ${i}`, `198.51.100.${i + 10}`)));
    const statuses = replies.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(LOGIN_MAX_PER_EMAIL);
    expect(statuses.filter((s) => s === 429)).toHaveLength(16 - LOGIN_MAX_PER_EMAIL);
  });

  it("gives a correct sign-in's attempt back, so signing in does not use up the allowance", async () => {
    await inviteAndAccept(h, "pat@example.test");
    for (let i = 0; i < 4; i++) expect((await login("pat@example.test", GOOD_PASSWORD, `198.51.100.${i + 1}`)).status).toBe(200);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email_or_ip LIKE 'email:%'").get()).toEqual({ n: 0 });
  });
});

describe("loopback peers share no IP bucket", () => {
  it("a flood of dead links from a local proxy does not lock out the next person's accept", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await h.request("POST", "/api/auth/invites/inspect", { body: { token: `not-a-real-token-${i}-xxxxxxxx` }, ip: "127.0.0.1" })).status).toBe(410);
    }
    const invite = await h.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "viewer" });
    const accepted = await h.request("POST", "/api/auth/invites/accept", { body: { token: tokenFromLink(invite.body.link), displayName: "Pat", password: GOOD_PASSWORD }, ip: "::ffff:127.0.0.1" });
    expect(accepted.status).toBe(200);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get()).toEqual({ n: 0 });
  });

  it("the per-address limit still applies to a loopback peer", async () => {
    await inviteAndAccept(h, "pat@example.test");
    for (let i = 0; i < LOGIN_MAX_PER_EMAIL; i++) await login("pat@example.test", `wrong password ${i}`, "127.0.0.1");
    expect((await login("pat@example.test", GOOD_PASSWORD, "127.0.0.1")).status).toBe(429);
  });
});

describe("several pending board invites for one address", () => {
  it("accepting one grants the others, and no pending invite is left behind", async () => {
    const alpha = await h.asOperator("POST", "/api/boards/ops/invites", { email: "multi@example.test", role: "collaborator" });
    await h.asOperator("POST", "/api/boards/design/invites", { email: "multi@example.test", role: "viewer" });
    const accepted = await h.request("POST", "/api/auth/invites/accept", { body: { token: tokenFromLink(alpha.body.link), displayName: "Multi", password: GOOD_PASSWORD } });
    expect(accepted.status).toBe(200);
    const me = await h.request("GET", "/api/member/me", { cookie: h.cookieFrom(accepted) });
    expect(me.body.boards).toEqual([{ department: "design", role: "viewer" }, { department: "ops", role: "collaborator" }]);
    expect((await h.asOperator("GET", "/api/people/invites")).body.invites).toEqual([]);
    const userId = me.body.user.id;
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ? AND used_at IS NOT NULL").get(userId)).toEqual({ n: 2 });
  });

  it("an owner instance invite is not consumed by accepting a board invite", async () => {
    await h.asOperator("POST", "/api/people/invites", { email: "multi@example.test", instanceRole: "owner" });
    const board = await h.asOperator("POST", "/api/boards/ops/invites", { email: "multi@example.test", role: "viewer" });
    const accepted = await h.request("POST", "/api/auth/invites/accept", { body: { token: tokenFromLink(board.body.link), displayName: "Multi", password: GOOD_PASSWORD } });
    expect(accepted.body.principal.kind).toBe("member");
    expect((await h.asOperator("GET", "/api/people/invites")).body.invites.map((i: any) => i.instanceRole)).toEqual(["owner"]);
  });
});

describe("changing instance role", () => {
  it("promoting a member to owner ends their member sessions", async () => {
    const pat = await inviteAndAccept(h, "pat@example.test");
    expect((await h.request("GET", "/api/member/me", { cookie: pat.cookie })).status).toBe(200);
    await h.asOperator("PATCH", `/api/people/${pat.userId}`, { instanceRole: "owner" });
    expect((await h.request("GET", "/api/member/me", { cookie: pat.cookie })).status).toBe(401);
    expect(memberSessions(pat.userId)).toBe(0);
    expect((await login("pat@example.test")).body.principal).toEqual({ kind: "operator" });
  });
});

describe("a busy gateway answers 429 and burns nothing", () => {
  it("invite accept: the link is still good afterwards", async () => {
    const busy: HashLimiter = { run: async () => { throw new HashBusyError(); }, stats: () => ({ running: 2, queued: 16 }) };
    const b = await startHarness({ limiter: busy });
    try {
      const invite = await b.asOperator("POST", "/api/boards/ops/invites", { email: "pat@example.test", role: "viewer" });
      const reply = await b.request("POST", "/api/auth/invites/accept", { body: { token: tokenFromLink(invite.body.link), displayName: "Pat", password: GOOD_PASSWORD } });
      expect(reply.status).toBe(429);
      expect(reply.header("retry-after")).toBe("2");
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM user_tokens WHERE used_at IS NULL AND revoked_at IS NULL").get()).toEqual({ n: 1 });
    } finally { b.close(); }
  });

  it("password reset: the link is still good afterwards", async () => {
    const busy: HashLimiter = { run: async () => { throw new HashBusyError(); }, stats: () => ({ running: 2, queued: 16 }) };
    const b = await startHarness({ limiter: busy });
    try {
      const user = createUser(b.db, { email: "pat@example.test", displayName: "Pat", passwordHash: null, createdBy: "operator" });
      const link = (await b.asOperator("POST", `/api/people/${user.id}/reset-link`)).body.link as string;
      const reply = await b.request("POST", "/api/auth/resets/complete", { body: { token: tokenFromLink(link), password: GOOD_PASSWORD } });
      expect(reply.status).toBe(429);
      expect(b.db.prepare("SELECT COUNT(*) AS n FROM user_tokens WHERE used_at IS NULL AND revoked_at IS NULL").get()).toEqual({ n: 1 });
    } finally { b.close(); }
  });
});

describe("a member session checks the user on every request", () => {
  it("a disabled user is refused even if nothing revoked their session", async () => {
    const pat = await inviteAndAccept(h, "pat@example.test");
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(pat.userId);
    expect(memberSessions(pat.userId)).toBe(1);
    expect((await h.request("GET", "/api/member/me", { cookie: pat.cookie })).status).toBe(401);
  });
});
