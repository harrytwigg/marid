import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestHome } from "./helpers/turn-parity-harness.js";
import type { Employee, Engine, JinnConfig } from "../../shared/types.js";

/**
 * A NEW routed session of a department-scoped employee starts on claude even
 * while claude's allowance is spent: the session could run nowhere else, so
 * the reroute that moves an open employee down the fallback chain leaves it
 * where it is.
 */

const HOME = createTestHome("jinn-scoped-engine-selection-");
const HEALTH_PATH = path.join(HOME, "tmp", "engine-health.json");

let newSessionEngineSelection: typeof import("../new-session-engine.js").newSessionEngineSelection;
let recordEngineUnavailable: typeof import("../../shared/engine-health.js").recordEngineUnavailable;
let scope: typeof import("../../work-items/department-scope.js");

const config = {
  gateway: {},
  engines: {
    default: "claude",
    claude: { bin: process.execPath, model: "sonnet", fallback: ["codex"] },
    codex: { bin: process.execPath, model: "gpt-5.6-sol" },
  },
  sessions: {},
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as JinnConfig;

const engines = new Map<string, Engine>([["claude", {} as Engine], ["codex", {} as Engine]]);

const worker = (name: string) => ({ name, engine: "claude", model: "sonnet", persona: "fixture" }) as unknown as Employee;

beforeAll(async () => {
  ({ newSessionEngineSelection } = await import("../new-session-engine.js"));
  ({ recordEngineUnavailable } = await import("../../shared/engine-health.js"));
  scope = await import("../../work-items/department-scope.js");
  scope.setEmployeeDepartmentResolver((employee) => (employee === "lab-dev" ? "lab" : "platform"));
  scope.setDepartmentScopeResolver((department) => (department === "lab" ? "scoped" : "open"));
});

afterAll(() => {
  scope.setEmployeeDepartmentResolver(null);
  scope.setDepartmentScopeResolver(null);
});

beforeEach(() => {
  fs.rmSync(HEALTH_PATH, { force: true });
  recordEngineUnavailable("claude", "quota window spent", Math.floor(Date.now() / 1000) + 60 * 60);
});

describe("newSessionEngineSelection with claude's allowance spent", () => {
  it("keeps a scoped employee on claude, with no reroute to return from", () => {
    const selection = newSessionEngineSelection(config, engines, { employee: worker("lab-dev") });

    expect(selection.engine).toBe("claude");
    expect(selection.model).toBe("sonnet");
    expect(selection.transportMeta).toBeUndefined();
  });

  it("still moves an open employee down the chain", () => {
    const selection = newSessionEngineSelection(config, engines, { employee: worker("open-dev") });

    expect(selection.engine).toBe("codex");
    expect(selection.transportMeta).toMatchObject({ engineOverride: { originalEngine: "claude" } });
  });
});
