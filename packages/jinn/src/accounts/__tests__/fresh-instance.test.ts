import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOOD_PASSWORD } from "./accounts-harness.js";
import { startBoardHarness, type BoardHarness } from "./board-harness.js";

let h: BoardHarness;
beforeAll(async () => { h = await startBoardHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

describe("a fresh instance: gateway auth on, no accounts yet", () => {
  it("says accounts are possible but none exist, so the operator can start", async () => {
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    const anon = await h.request("GET", "/api/auth/state");
    expect(anon.body).toMatchObject({ authRequired: true, accountsEnabled: true, hasAccounts: false, principal: null });
    const operator = await h.operator("GET", "/api/auth/state");
    expect(operator.body).toMatchObject({ accountsEnabled: true, hasAccounts: false, principal: { kind: "operator" } });
  });

  it("the operator creates the first account with set-up-my-sign-in, and the state flips to hasAccounts", async () => {
    const setup = await h.operator("POST", "/api/account/setup", { email: "boss@example.test", displayName: "Boss", password: GOOD_PASSWORD });
    expect(setup.status).toBe(200);
    expect(setup.body.person).toMatchObject({ email: "boss@example.test", instanceRole: "owner" });
    const state = await h.request("GET", "/api/auth/state");
    expect(state.body).toMatchObject({ accountsEnabled: true, hasAccounts: true, principal: null });
    const login = await h.request("POST", "/api/auth/login", { body: { email: "boss@example.test", password: GOOD_PASSWORD } });
    expect(login.status).toBe(200);
  });
});

describe("a second fresh instance path: the first account arrives by instance invite", () => {
  it("an instance invite is created and accepted while no account exists", async () => {
    const fresh = await startBoardHarness();
    try {
      // The singleton registry is shared within this file, so clear it to be a fresh instance again.
      for (const table of ["user_sessions", "user_tokens", "board_members", "users"]) fresh.db.prepare(`DELETE FROM ${table}`).run();
      expect((await fresh.request("GET", "/api/auth/state")).body).toMatchObject({ accountsEnabled: true, hasAccounts: false });
      const invite = await fresh.operator("POST", "/api/people/invites", { email: "first@example.test", instanceRole: "member" });
      expect(invite.status).toBe(200);
      const accepted = await fresh.request("POST", "/api/auth/invites/accept", { body: { token: invite.body.link.split("#")[1], displayName: "First", password: GOOD_PASSWORD } });
      expect(accepted.status).toBe(200);
      expect((await fresh.request("GET", "/api/auth/state")).body).toMatchObject({ accountsEnabled: true, hasAccounts: true });
    } finally { await fresh.close(); }
  });
});
