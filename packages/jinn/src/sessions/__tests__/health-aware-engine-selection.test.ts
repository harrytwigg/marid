import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  eventually,
  scriptedEngine,
  testConfig,
} from "./helpers/turn-parity-harness.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

/**
 * PLA-184 — a NEW routed session used to pick its engine from config and the
 * employee YAML alone, so an engine already known to be out of allowance was
 * discovered again, one burned turn per session. Health now orders that pick.
 */

const HOME = createTestHome("jinn-health-engine-selection-");
const HEALTH_PATH = path.join(HOME, "tmp", "engine-health.json");
const dbModule = await import("../../shared/db.js");

let registry: typeof import("../registry.js");
let ManagerClass: typeof import("../manager.js").SessionManager;
let recordEngineUnavailable: typeof import("../../shared/engine-health.js").recordEngineUnavailable;
let validateNewSessionSelection: typeof import("../session-patch.js").validateNewSessionSelection;
let invalidateModelRegistry: typeof import("../../shared/models.js").invalidateModelRegistry;
let getModelRegistry: typeof import("../../shared/models.js").getModelRegistry;

beforeAll(async () => {
  [registry, { SessionManager: ManagerClass }, { recordEngineUnavailable }, { validateNewSessionSelection }, { invalidateModelRegistry, getModelRegistry }] =
    await Promise.all([
      import("../registry.js"),
      import("../manager.js"),
      import("../../shared/engine-health.js"),
      import("../session-patch.js"),
      import("../../shared/models.js"),
    ]);
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  fs.rmSync(HEALTH_PATH, { force: true });
  invalidateModelRegistry();
});

/** A codex-preferring employee, with the codex-only defaults that come with it. */
const employee = {
  name: "a-worker",
  engine: "codex",
  model: "gpt-5.6-sol",
  effortLevel: "xhigh",
  persona: "Engine selection fixture",
} as unknown as Employee;

/** Both engines resolve as installed; codex's chain names claude. */
function config(): JinnConfig {
  const base = testConfig() as unknown as Record<string, unknown>;
  const engines = base["engines"] as Record<string, unknown>;
  engines["default"] = "codex";
  engines["codex"] = { bin: process.execPath, model: "gpt-5.6-sol", fallback: ["claude"] };
  engines["claude"] = { bin: process.execPath, model: "opus" };
  // The selection path validates against the registry, so both engines need a
  // catalog the employee's configured model actually appears in.
  base["models"] = {
    claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }] },
  };
  return base as unknown as JinnConfig;
}

function manager() {
  const engines = new Map<string, unknown>([
    ["codex", scriptedEngine("codex", [engineResult({ result: "ok" })])],
    ["claude", scriptedEngine("claude", [engineResult({ result: "ok" })])],
  ]);
  return new ManagerClass(config(), engines as never, "selection-boot");
}

/** Route one turn and hand back the session it created. */
async function routedSession(opts: Record<string, unknown> = {}) {
  const key = `stub:selection-${Math.random().toString(16).slice(2)}`;
  const routed = await manager().route(connectorMessage(key, "probe"), connectorStub(), {
    employee: employee as never,
    ...opts,
  });
  const id = routed!.sessionId;
  await eventually(() => {
    const status = registry.getSession(id)?.status;
    return status === "idle" || status === "error" || status === "interrupted";
  });
  return registry.getSession(id)!;
}

const anHourOut = () => Math.floor(Date.now() / 1000) + 60 * 60;

describe("SessionManager.route — engine selection under a spent allowance", () => {
  it("starts on the healthy chain member and drops the codex-only model and effort", async () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    const session = await routedSession();

    expect(session.engine).toBe("claude");
    expect(session.model).not.toBe("gpt-5.6-sol");
    expect(session.effortLevel).not.toBe("xhigh");
  });

  it("still runs codex when the caller named it", async () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    const session = await routedSession({ engine: "codex" });

    expect(session.engine).toBe("codex");
  });

  it("still runs codex when the caller named a codex model", async () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    const session = await routedSession({ model: "gpt-5.6-sol" });

    expect(session.engine).toBe("codex");
    expect(session.model).toBe("gpt-5.6-sol");
  });

  it("keeps the employee's engine and its defaults while the allowance holds", async () => {
    const session = await routedSession();

    expect(session.engine).toBe("codex");
    expect(session.model).toBe("gpt-5.6-sol");
    expect(session.effortLevel).toBe("xhigh");
  });
});

/** The same decision on the web/spawn/dispatch path, which validates rather than routes. */
describe("validateNewSessionSelection — engine selection under a spent allowance", () => {
  it("moves a config-default preference off a spent engine", () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    expect(validateNewSessionSelection(config(), {})).toMatchObject({ ok: true, engine: "claude" });
  });

  it("drops the codex-only model and effort that came with the engine it moved off", () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    const selection = validateNewSessionSelection(
      config(),
      {},
      { engine: "codex", model: "gpt-5.6-sol", effortLevel: "xhigh", employee: "a-worker" },
    );

    expect(selection).toEqual({ ok: true, engine: "claude", model: undefined, effortLevel: undefined });
  });

  it("runs the engine the request named, spent allowance or not", () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    expect(validateNewSessionSelection(config(), { engine: "codex" })).toMatchObject({ ok: true, engine: "codex" });
  });

  it("lets a named model pin the engine it belongs to", () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());

    expect(validateNewSessionSelection(config(), { model: "gpt-5.6-sol" }, { engine: "codex" }))
      .toMatchObject({ ok: true, engine: "codex", model: "gpt-5.6-sol" });
  });

  it("never resolves a model the engine it moved to does not serve (PLA-202)", () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());
    const cfg = config();

    const selection = validateNewSessionSelection(cfg, {}, { engine: "codex", model: "gpt-5.6-sol", employee: "a-worker" });

    expect(selection.engine).toBe("claude");
    const served = getModelRegistry(cfg).claude!.models.map((model) => model.id);
    expect(selection.model === undefined || served.includes(selection.model)).toBe(true);
  });

  it("keeps the preference when nothing in the chain is healthy either", () => {
    recordEngineUnavailable("codex", "out of quota", anHourOut());
    recordEngineUnavailable("claude", "out of quota", anHourOut());

    expect(validateNewSessionSelection(config(), {}, { engine: "codex", model: "gpt-5.6-sol" }))
      .toMatchObject({ ok: true, engine: "codex", model: "gpt-5.6-sol" });
  });
});
