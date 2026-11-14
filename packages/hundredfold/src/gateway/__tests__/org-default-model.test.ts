import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine, HundredfoldConfig } from "../../shared/types.js";

let tmpHome: string;

vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  resolveHundredfoldHome: () => tmpHome,
}));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

import { scanOrg } from "../org.js";
import { resolveSystemEmployees } from "../system-employees.js";
import { newSessionEngineSelection } from "../../sessions/new-session-engine.js";
import { linkHealthKey } from "../../shared/fallback-chain-health.js";

function writeEmployee(name: string, fields: string) {
  const dir = path.join(tmpHome, "org", "platform");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), `name: ${name}\npersona: A worker\n${fields}\n`, "utf-8");
}

function configWith(opencodeModel?: string): HundredfoldConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      opencode: { bin: "opencode", ...(opencodeModel ? { model: opencodeModel } : {}) },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
  } as unknown as HundredfoldConfig;
}

describe("employee files that set no model", () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "org-default-model-"));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("keeps the sonnet alias for a Claude employee", () => {
    writeEmployee("claude-worker", "engine: claude");
    writeEmployee("implicit-worker", "");
    const registry = scanOrg(configWith("opencode-go/deepseek-v4.1-flash"));
    expect(registry.get("claude-worker")!.model).toBe("sonnet");
    expect(registry.get("implicit-worker")!.model).toBe("sonnet");
  });

  it("starts an opencode employee on engines.opencode.model, not a Claude alias", () => {
    writeEmployee("oc-worker", "engine: opencode");
    const employee = scanOrg(configWith("opencode-go/deepseek-v4.1-flash")).get("oc-worker")!;
    expect(employee.engine).toBe("opencode");
    expect(employee.model).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("leaves the model unset, so the engine's own default stands, when none is configured", () => {
    writeEmployee("oc-worker", "engine: opencode");
    expect(scanOrg(configWith()).get("oc-worker")!.model).toBeUndefined();
    // No config at all (a read before the gateway has one) is the same: never "sonnet".
    expect(scanOrg().get("oc-worker")!.model).toBeUndefined();
  });

  it("applies to every non-Claude engine, and ignores a blank model", () => {
    writeEmployee("codex-worker", "engine: codex");
    writeEmployee("blank-worker", "engine: opencode\nmodel: '   '");
    const registry = scanOrg(configWith("opencode-go/deepseek-v4.1-flash"));
    expect(registry.get("codex-worker")!.model).toBe("gpt-5.5");
    expect(registry.get("blank-worker")!.model).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("keeps a model the file names", () => {
    writeEmployee("oc-worker", "engine: opencode\nmodel: openrouter/z-ai/glm-5");
    writeEmployee("sonnet-worker", "engine: claude\nmodel: opus");
    const registry = scanOrg(configWith("opencode-go/deepseek-v4.1-flash"));
    expect(registry.get("oc-worker")!.model).toBe("openrouter/z-ai/glm-5");
    expect(registry.get("sonnet-worker")!.model).toBe("opus");
  });

  it("gives the new session the configured model, and the provider's health key", () => {
    writeEmployee("oc-worker", "engine: opencode");
    const config = configWith("opencode-go/deepseek-v4.1-flash");
    const employee = scanOrg(config).get("oc-worker")!;
    const engines = new Map<string, Engine>([
      ["claude", { name: "claude", run: vi.fn() }],
      ["opencode", { name: "opencode", run: vi.fn() }],
    ]);

    const selection = newSessionEngineSelection(config, engines, { employee });
    expect(selection.engine).toBe("opencode");
    expect(selection.model).toBe("opencode-go/deepseek-v4.1-flash");

    // `sonnet` named no provider, so this read only the engine-wide key and a spent provider account went unseen.
    expect(linkHealthKey({ engine: "opencode", model: selection.model, account: "opencode" })).toBe("opencode/opencode-go");
  });

  it("a session with no configured model starts with no model at all", () => {
    writeEmployee("oc-worker", "engine: opencode");
    const config = configWith();
    const employee = scanOrg(config).get("oc-worker")!;
    const engines = new Map<string, Engine>([["opencode", { name: "opencode", run: vi.fn() }]]);
    expect(newSessionEngineSelection(config, engines, { employee }).model).toBeFalsy();
  });

  it("moves a system employee's model with its engine override", () => {
    writeEmployee("todo-dispatcher", "engine: opencode");
    const withModel = scanOrg(configWith("opencode-go/deepseek-v4.1-flash")).get("todo-dispatcher")!;
    expect(withModel.engine).toBe("opencode");
    expect(withModel.model).toBe("opencode-go/deepseek-v4.1-flash");
    // Not the built-in's Claude model, and not an invented one, when nothing is configured.
    expect(scanOrg(configWith()).get("todo-dispatcher")!.model).toBeUndefined();
    writeEmployee("todo-dispatcher", "engine: opencode\nmodel: openrouter/z-ai/glm-5");
    expect(scanOrg(configWith()).get("todo-dispatcher")!.model).toBe("openrouter/z-ai/glm-5");
  });

  it("leaves an engine-less system employee file on the built-in's model", () => {
    writeEmployee("todo-dispatcher", "alwaysNotify: false");
    const dispatcher = scanOrg(configWith("opencode-go/deepseek-v4.1-flash")).get("todo-dispatcher")!;
    expect(dispatcher.engine).toBe("claude");
    expect(dispatcher.model).toBe("opus");
  });

  it("gives system employees no model on a non-Claude default engine with none configured", () => {
    const config = { engines: { default: "opencode", opencode: { bin: "opencode" } } } as unknown as HundredfoldConfig;
    for (const employee of resolveSystemEmployees(config)) {
      expect(employee.engine).toBe("opencode");
      expect(employee.model).toBeUndefined();
    }
    const configured = { engines: { default: "opencode", opencode: { bin: "opencode", model: "opencode-go/flash" } } } as unknown as HundredfoldConfig;
    expect(resolveSystemEmployees(configured).every((employee) => employee.model === "opencode-go/flash")).toBe(true);
  });
});
