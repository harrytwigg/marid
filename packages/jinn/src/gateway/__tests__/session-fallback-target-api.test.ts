import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";
import {
  baseConfig, call, dbModule, delegate, emitted, loadApi, makeParent, registry, resetFallbackFixture, setConfig, spawn, toolHeaders, unloadApi,
} from "./session-fallback-api-harness.js";

/** A session's own fallback target through the HTTP surface: PUT's validation and persistence, the view, and what children inherit. */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(resetFallbackFixture);

const target = { engine: "codex", model: "gpt-mapped" };
const storedTarget = (id: string) => registry.getSession(id)!.fallbackTarget;

function parentWith(mode: SessionFallbackMode | null, fallbackTarget: typeof target | null = target) {
  const parent = makeParent(mode);
  registry.updateSession(parent.id, { fallbackTarget });
  return parent;
}

describe("PUT /api/sessions/:id { fallbackTarget }", () => {
  it("stores the target, emits session:updated and answers with a view naming it as the session's own", async () => {
    const session = makeParent(null);
    emitted.length = 0;
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: target });
    expect(put.status).toBe(200);
    expect(put.body.fallback).toMatchObject({ targetSource: "session", target: { engine: "codex", model: "gpt-mapped", label: "gpt-mapped" } });
    expect(storedTarget(session.id)).toEqual(target);
    expect(emitted).toContainEqual(["session:updated", { sessionId: session.id }]);
  });

  it("survives the registry being closed and opened again, and GET reports it", async () => {
    const session = makeParent(null);
    await call("PATCH", `/api/sessions/${session.id}`, { fallbackTarget: target });
    dbModule.__closeDbForTest();
    const got = await call("GET", `/api/sessions/${session.id}`);
    expect(got.body.fallback).toMatchObject({ mode: "fallback", targetSource: "session", target: { engine: "codex", model: "gpt-mapped" } });
  });

  it("null clears it, and the view goes back to the config's chain", async () => {
    const session = parentWith(null);
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: null });
    expect(put.status).toBe(200);
    expect(storedTarget(session.id)).toBeNull();
    expect(put.body.fallback).toMatchObject({ targetSource: "config", target: { engine: "codex", model: "gpt-mapped" } });
  });

  it("rides along with a mode change, and a mode change alone leaves the target", async () => {
    const session = parentWith("fallback");
    expect((await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: "auto-resume" })).status).toBe(200);
    expect(storedTarget(session.id)).toEqual(target);
    const both = await call("PUT", `/api/sessions/${session.id}`, { fallbackMode: "fallback-children", fallbackTarget: { engine: "claude", model: "opus" } });
    expect(both.status).toBe(200);
    expect(registry.getSession(session.id)).toMatchObject({ fallbackMode: "fallback-children", fallbackTarget: { engine: "claude", model: "opus" } });
  });

  it.each([["codex"], [7], [[]], [{ engine: "codex" }], [{ model: "x" }], [{ engine: "", model: "x" }]])(
    "refuses a malformed %j with a 400, changing nothing", async (bad) => {
      const session = parentWith("fallback");
      const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: bad });
      expect(put.status).toBe(400);
      expect(put.body.error).toMatch(/fallbackTarget must be null or an object/);
      expect(storedTarget(session.id)).toEqual(target);
    },
  );

  it("refuses an unknown engine and a model the engine does not offer, naming why", async () => {
    const session = makeParent(null);
    const noEngine = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: { engine: "nope", model: "x" } });
    expect(noEngine.status).toBe(400);
    expect(noEngine.body.error).toMatch(/fallbackTarget refused: unknown engine "nope"/);
    const noModel = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: { engine: "codex", model: "gpt-9" } });
    expect(noModel.status).toBe(400);
    expect(noModel.body.error).toMatch(/unknown model "gpt-9" for engine "codex"/);
    expect(storedTarget(session.id)).toBeNull();
  });

  it("refuses a non-claude target for a department-scoped session, and takes a claude one", async () => {
    const session = makeParent(null);
    dbModule.initDb().prepare("UPDATE sessions SET scope_department = 'ops' WHERE id = ?").run(session.id);
    const refused = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: target });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/confined to a department.*claude/);
    expect(storedTarget(session.id)).toBeNull();
    expect((await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: { engine: "claude", model: "opus" } })).status).toBe(200);
  });

  it("is refused together with a bad target before an engine switch applies", async () => {
    const session = makeParent("fallback");
    const put = await call("PUT", `/api/sessions/${session.id}`, { engine: "codex", fallbackTarget: { engine: "nope", model: "x" } });
    expect(put.status).toBe(400);
    expect(registry.getSession(session.id)).toMatchObject({ engine: "claude", fallbackTarget: null });
  });

  it("is kept, though unused, in auto-resume, and the view still shows it", async () => {
    const session = makeParent("auto-resume");
    const put = await call("PUT", `/api/sessions/${session.id}`, { fallbackTarget: target });
    expect(put.body.fallback).toMatchObject({ mode: "auto-resume", targetSource: "session", target: { engine: "codex" } });
  });
});

describe("GET /api/sessions/:id", () => {
  it("says the chain's target comes from the config when the session has none", async () => {
    const got = await call("GET", `/api/sessions/${makeParent(null).id}`);
    expect(got.body.fallback).toMatchObject({ targetSource: "config", target: { engine: "codex" } });
  });
});

describe("inheritance", () => {
  it("a fallback-children parent's spawned child takes its target, through to a grandchild", async () => {
    const parent = parentWith("fallback-children");
    const child = await spawn({ parentSessionId: parent.id });
    expect(child.status).toBe(201);
    expect(storedTarget(child.body.id)).toEqual(target);
    const grandchild = await spawn({}, toolHeaders(child.body.id));
    expect(storedTarget(grandchild.body.id)).toEqual(target);
  });

  it.each<SessionFallbackMode | null>(["fallback", "auto-resume", null])("a %s parent's child gets no target", async (mode) => {
    const child = await spawn({ parentSessionId: parentWith(mode).id });
    expect(storedTarget(child.body.id)).toBeNull();
  });

  it("a fallback-children parent's child told to auto-resume gets none, and a config default passes it on", async () => {
    const parent = parentWith("fallback-children");
    expect(storedTarget((await spawn({ parentSessionId: parent.id, fallbackMode: "auto-resume" })).body.id)).toBeNull();
    setConfig({ ...baseConfig, sessions: { fallbackMode: "fallback-children" } } as JinnConfig);
    expect(storedTarget((await spawn({ parentSessionId: parentWith(null).id })).body.id)).toEqual(target);
  });

  it("a delegation from a fallback-children session passes the target on; from a fallback session it does not", async () => {
    const passed = await delegate({}, toolHeaders(parentWith("fallback-children").id));
    expect(passed.status).toBe(201);
    expect(storedTarget(passed.body.sessionId)).toEqual(target);
    const kept = await delegate({}, toolHeaders(parentWith("fallback").id));
    expect(storedTarget(kept.body.sessionId)).toBeNull();
  });

  it("a root session has no target", async () => {
    expect(storedTarget((await spawn({})).body.id)).toBeNull();
  });
});
