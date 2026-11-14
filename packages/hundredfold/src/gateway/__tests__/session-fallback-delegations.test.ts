import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";
import {
  call, delegate, loadApi, makeParent, registry, resetFallbackFixture, stored, toolHeaders, unloadApi,
} from "./session-fallback-api-harness.js";

/** A session's fallback mode through POST /api/delegations, and PUT combined with an engine switch. */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(resetFallbackFixture);

describe("POST /api/delegations", () => {
  it("stores and echoes an explicit mode", async () => {
    const created = await delegate({ fallbackMode: "auto-resume" });
    expect(created.status).toBe(201);
    expect(created.body.fallbackMode).toBe("auto-resume");
    expect(stored(created.body.sessionId)).toBe("auto-resume");
  });

  it("a root delegation stores NULL and echoes null", async () => {
    const created = await delegate({});
    expect(created.status).toBe(201);
    expect(created.body.fallbackMode).toBeNull();
    expect(stored(created.body.sessionId)).toBeNull();
  });

  it("refuses a bad value with a 400 before minting anything", async () => {
    const bad = await delegate({ fallbackMode: "never" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/fallback, fallback-children, auto-resume/);
    expect(bad.body.workItemId).toBeUndefined();
    const nulled = await delegate({ fallbackMode: null });
    expect(nulled.status).toBe(400);
    expect(nulled.body.error).toMatch(/\(got null\)$/);
  });

  it.each<[SessionFallbackMode | null, SessionFallbackMode]>([
    ["fallback-children", "fallback-children"], ["fallback", "auto-resume"], ["auto-resume", "auto-resume"], [null, "auto-resume"],
  ])("a delegation from a %s session stores %s", async (parentMode, expected) => {
    const created = await delegate({}, toolHeaders(makeParent(parentMode).id));
    expect(created.status).toBe(201);
    expect(created.body.fallbackMode).toBe(expected);
    expect(stored(created.body.sessionId)).toBe(expected);
  });

  it("an explicit mode beats the caller's", async () => {
    const created = await delegate({ fallbackMode: "fallback" }, toolHeaders(makeParent("auto-resume").id));
    expect(stored(created.body.sessionId)).toBe("fallback");
  });

  it("echoes the stored mode on an idempotent replay, whatever the retry says", async () => {
    const caller = toolHeaders(makeParent("fallback-children").id);
    const first = await delegate({ idempotencyKey: "fallback-mode-replay" }, caller);
    expect(first.status).toBe(201);
    const replay = await delegate({ idempotencyKey: "fallback-mode-replay", fallbackMode: "auto-resume" }, caller);
    expect(replay.body).toMatchObject({ replayed: true, sessionId: first.body.sessionId, fallbackMode: "fallback-children" });
  });
});

describe("PUT /api/sessions/:id with an engine switch", () => {
  it("applies the engine switch and the mode together", async () => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { engine: "codex", fallbackMode: "auto-resume" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ engine: "codex", fallbackMode: "auto-resume" });
    expect(put.body.fallback).toMatchObject({ mode: "auto-resume", modeSource: "session" });
    expect(registry.getSession(session.id)).toMatchObject({ engine: "codex", fallbackMode: "auto-resume" });
  });

  it("changes nothing, mode included, when the engine switch is refused", async () => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { engine: "no-such-engine", fallbackMode: "auto-resume" });
    expect(put.status).toBe(400);
    expect(registry.getSession(session.id)).toMatchObject({ engine: "claude", fallbackMode: "fallback" });
  });

  it("refuses a bad mode before switching the engine", async () => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { engine: "codex", fallbackMode: "off" });
    expect(put.status).toBe(400);
    expect(registry.getSession(session.id)).toMatchObject({ engine: "claude", fallbackMode: "fallback" });
  });
});

