import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { JinnConfig } from "../../shared/types.js";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";
import {
  HEALTH_PATH, baseConfig, call, dbModule, emitted, loadApi, makeParent, registry, resetFallbackFixture, setConfig,
  spawn, stored, toolHeaders, unloadApi,
} from "./session-fallback-api-harness.js";

/**
 * A session's fallback mode through the HTTP surface: the view GET reports, PUT's validation and
 * persistence, and what POST /api/sessions accepts, refuses and inherits. Delegations are in
 * session-fallback-delegations.test.ts.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(resetFallbackFixture);

describe("GET /api/sessions/:id", () => {
  it("carries the fallback view: the default mode, where it came from and the resolved target", async () => {
    const session = makeParent(null);
    const got = await call("GET", `/api/sessions/${session.id}`);
    expect(got.status).toBe(200);
    expect(got.body.fallback).toEqual({
      mode: "fallback", modeSource: "default", target: { engine: "codex", model: "gpt-mapped", label: "gpt-mapped" }, targetSource: "config", allowedEngines: expect.any(Array), chain: expect.any(Object),
    });
  });

  it("reports a stored mode with source session, and a null target when the chain is empty", async () => {
    setConfig({ ...baseConfig, engines: { ...baseConfig.engines, claude: { bin: "claude", model: "opus", fallback: [] } } } as JinnConfig);
    const session = makeParent("auto-resume");
    expect((await call("GET", `/api/sessions/${session.id}`)).body.fallback).toEqual({ mode: "auto-resume", modeSource: "session", target: null, targetSource: "config", allowedEngines: expect.any(Array), chain: expect.any(Object) });
  });

  it("follows sessions.fallbackMode for a session with none of its own", async () => {
    setConfig({ ...baseConfig, sessions: { fallbackMode: "fallback-children" } } as JinnConfig);
    const got = await call("GET", `/api/sessions/${makeParent(null).id}`);
    expect(got.body.fallback).toMatchObject({ mode: "fallback-children", modeSource: "default" });
  });

  it("is on the single-session response only, not the list", async () => {
    makeParent(null);
    const list = await call("GET", "/api/sessions");
    expect(list.status).toBe(200);
    for (const row of list.body.sessions ?? list.body) expect(row).not.toHaveProperty("fallback");
  });
});

describe("PUT /api/sessions/:id", () => {
  it("takes fallbackMode alone, persists it, emits session:updated and answers with the view", async () => {
    const session = makeParent(null);
    for (const method of ["PUT", "PATCH"]) {
      emitted.length = 0;
      const mode = method === "PUT" ? "auto-resume" : "fallback-children";
      const put = await call(method, `/api/sessions/${session.id}`, { fallbackMode: mode });
      expect(put.status).toBe(200);
      expect(put.body.fallbackMode).toBe(mode);
      expect(put.body.fallback).toMatchObject({ mode, modeSource: "session" });
      expect(stored(session.id)).toBe(mode);
      expect(emitted).toContainEqual(["session:updated", { sessionId: session.id }]);
    }
  });

  it("survives the registry being closed and opened again", async () => {
    const session = makeParent(null);
    await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: "auto-resume" });
    dbModule.__closeDbForTest();
    const got = await call("GET", `/api/sessions/${session.id}`);
    expect(got.body.fallback).toMatchObject({ mode: "auto-resume", modeSource: "session" });
  });

  it("can ride along with a title, and does not rewrite the engine", async () => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: "auto-resume", title: `retitled ${Date.now()}` });
    expect(put.status).toBe(200);
    expect(put.body.fallback.mode).toBe("auto-resume");
    expect(registry.getSession(session.id)).toMatchObject({ engine: "claude", fallbackMode: "auto-resume" });
  });

  it.each([["wait"], [2], [""], ["Fallback"], [[]]])("refuses %j with a 400 naming the allowed values, changing nothing", async (bad) => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: bad });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/fallbackMode must be one of fallback, fallback-children, auto-resume/);
    expect(stored(session.id)).toBe("fallback");
  });

  it("null clears the session's own mode, which then follows the config default again", async () => {
    setConfig({ ...baseConfig, sessions: { fallbackMode: "fallback-children" } } as JinnConfig);
    const session = makeParent("auto-resume");
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: null });
    expect(put.status).toBe(200);
    expect(put.body.fallbackMode).toBeNull();
    expect(put.body.fallback).toMatchObject({ mode: "fallback-children", modeSource: "default" });
    expect(stored(session.id)).toBeNull();
    expect((await call("PATCH", `/api/sessions/${session.id}`, { fallbackMode: null })).status).toBe(200);
  });

  it("still refuses a body with nothing to update", async () => {
    const put = await call("PUT", `/api/sessions/${makeParent(null).id}`, {});
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/no valid fields/);
  });
});

describe("POST /api/sessions", () => {
  it("stores an explicit mode, and a root with none stores NULL", async () => {
    const explicit = await spawn({ fallbackMode: "auto-resume" });
    expect(explicit.status).toBe(201);
    expect(stored(explicit.body.id)).toBe("auto-resume");
    const root = await spawn({});
    expect(root.status).toBe(201);
    expect(stored(root.body.id)).toBeNull();
  });

  it("refuses a bad value, null included, with a 400 naming the three, and creates nothing", async () => {
    const before = registry.listSessions().length;
    const bad = await spawn({ fallbackMode: "off" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/fallback, fallback-children, auto-resume/);
    const nulled = await spawn({ fallbackMode: null });
    expect(nulled.status).toBe(400);
    expect(nulled.body.error).toMatch(/\(got null\)$/);
    expect(registry.listSessions()).toHaveLength(before);
  });

  it.each<[string, SessionFallbackMode | null, SessionFallbackMode]>([
    ["a fallback-children parent passes it on", "fallback-children", "fallback-children"],
    ["a fallback parent's child gets auto-resume", "fallback", "auto-resume"],
    ["an auto-resume parent's child gets auto-resume", "auto-resume", "auto-resume"],
    ["a legacy NULL parent follows the config default (fallback), so its child gets auto-resume", null, "auto-resume"],
  ])("%s", async (_name, parentMode, expected) => {
    const parent = makeParent(parentMode);
    const child = await spawn({ parentSessionId: parent.id });
    expect(child.status).toBe(201);
    expect(stored(child.body.id)).toBe(expected);
  });

  it("an explicit mode wins over the parent's, and a legacy NULL parent follows a fallback-children default", async () => {
    const explicit = await spawn({ parentSessionId: makeParent("auto-resume").id, fallbackMode: "fallback" });
    expect(stored(explicit.body.id)).toBe("fallback");
    setConfig({ ...baseConfig, sessions: { fallbackMode: "fallback-children" } } as JinnConfig);
    const inherited = await spawn({ parentSessionId: makeParent(null).id });
    expect(stored(inherited.body.id)).toBe("fallback-children");
  });

  it("a tool spawn is the caller's child and takes its mode, through to a grandchild", async () => {
    const caller = makeParent("fallback-children");
    const child = await spawn({}, toolHeaders(caller.id));
    expect(registry.getSession(child.body.id)!.parentSessionId).toBe(caller.id);
    expect(stored(child.body.id)).toBe("fallback-children");
    const grandchild = await spawn({}, toolHeaders(child.body.id));
    expect(stored(grandchild.body.id)).toBe("fallback-children");
    const fromFallback = await spawn({}, toolHeaders(makeParent("fallback").id));
    expect(stored(fromFallback.body.id)).toBe("auto-resume");
  });

  it("an auto-resume child starts on its preferred engine when that engine is spent; one asking for fallback does not", async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({ claude: { state: "exhausted", until, recheckAt: until, reason: "quota window spent" } }));
    const parent = makeParent("fallback");
    const inherited = await spawn({ employee: "a-worker", parentSessionId: parent.id });
    expect(registry.getSession(inherited.body.id)).toMatchObject({ engine: "claude", fallbackMode: "auto-resume" });
    expect(registry.getSession(inherited.body.id)!.transportMeta?.engineOverride).toBeUndefined();
    const asked = await spawn({ employee: "a-worker", parentSessionId: parent.id, fallbackMode: "fallback" });
    expect(registry.getSession(asked.body.id)).toMatchObject({ engine: "codex", fallbackMode: "fallback" });
  });
});

