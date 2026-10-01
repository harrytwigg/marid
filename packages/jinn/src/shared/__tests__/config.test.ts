import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { normalizeClaudeEngineConfig, validateConfigShape } from "../config.js";
import type { JinnConfig } from "../types.js";
import { expectPosixMode } from "../test-support/posix-mode.js";

describe("deprecated Talk configuration compatibility", () => {
  it("keeps the retired orchestrator keys source-compatible for patch upgrades", () => {
    const legacyTalkConfig = {
      enabled: false,
      engine: "claude",
      orchestratorModel: "sonnet",
      kokoro: { voice: "af_heart" },
    } satisfies NonNullable<JinnConfig["talk"]>;

    expect(legacyTalkConfig).toMatchObject({
      enabled: false,
      engine: "claude",
      orchestratorModel: "sonnet",
    });
  });
});

describe("normalizeClaudeEngineConfig", () => {
  it("applies the maxLivePtys default", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus" });
    expect(out.maxLivePtys).toBe(8);
  });

  it("preserves a configured maxLivePtys", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", maxLivePtys: 16 });
    expect(out.maxLivePtys).toBe(16);
  });
});

describe("validateConfigShape", () => {
  const withRealtime = (realtime: unknown) => validateConfigShape({
    engines: { claude: { bin: "claude", model: "opus" } },
    realtime,
  });

  /**
   * A bad `realtime` value does not fail until a voice session is opened, and
   * opening one is a billed call. It is caught here instead, in the same words
   * as every other config mistake.
   */
  it("accepts the realtime block the provider union actually allows", () => {
    expect(withRealtime({
      provider: "openai",
      model: "gpt-realtime",
      apiKey: "${OPENAI_API_KEY}",
      voice: "marin",
      turnDetection: { type: "semantic_vad" },
      noiseReduction: "near_field",
    })).toEqual([]);
    expect(withRealtime({ turnDetection: "server_vad" })).toEqual([]);
    expect(withRealtime({ turnDetection: "none" })).toEqual([]);
    expect(withRealtime(undefined)).toEqual([]);
  });

  it("refuses a turn detection nobody implements, and says what is allowed", () => {
    const problems = withRealtime({ turnDetection: "sideways" });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("realtime.turnDetection must be");
    expect(problems[0]).toContain("server_vad");
    expect(problems[0]).toContain('"sideways"');
  });

  // `semantic_vad` carries an eagerness, so it is only valid as a mapping. An
  // operator hand-editing the file will reach for the bare name first.
  it("refuses bare semantic_vad, which is the mapping form's easiest mistake", () => {
    expect(withRealtime({ turnDetection: "semantic_vad" })).toHaveLength(1);
    expect(withRealtime({ turnDetection: { type: "sideways" } })[0])
      .toContain("realtime.turnDetection.type must be one of");
  });

  it("refuses a noise reduction outside the two the provider filters on", () => {
    const problems = withRealtime({ noiseReduction: "studio" });

    expect(problems).toEqual([
      'realtime.noiseReduction must be one of: near_field, far_field (got "studio")',
    ]);
  });

  it("refuses a non-string where the block holds names", () => {
    expect(withRealtime({ provider: 7 })).toEqual(["realtime.provider must be a string (got number)"]);
    expect(withRealtime([])).toEqual(["realtime must be a mapping"]);
  });

  it("accepts knowledge steering and context.alwaysInclude, and treats empty blocks as absent", () => {
    const base = { engines: { claude: {} } };
    expect(validateConfigShape({ ...base, knowledge: { guidance: "g", missHint: "m" }, context: { alwaysInclude: ["knowledge/state.md"] } })).toEqual([]);
    expect(validateConfigShape({ ...base, knowledge: null, context: null })).toEqual([]);
  });

  it("rejects malformed knowledge and context.alwaysInclude", () => {
    const base = { engines: { claude: {} } };
    expect(validateConfigShape({ ...base, knowledge: [] })).toEqual(["knowledge must be a mapping"]);
    expect(validateConfigShape({ ...base, knowledge: { guidance: 3 } })).toEqual(["knowledge.guidance must be a string (got number)"]);
    expect(validateConfigShape({ ...base, knowledge: { missHint: {} } })).toEqual(["knowledge.missHint must be a string (got object)"]);
    expect(validateConfigShape({ ...base, context: "x" })).toEqual(["context must be a mapping"]);
    expect(validateConfigShape({ ...base, context: { alwaysInclude: "knowledge/state.md" } })).toEqual(["context.alwaysInclude must be a list of instance-relative file paths"]);
    expect(validateConfigShape({ ...base, context: { alwaysInclude: [1] } })).toEqual(["context.alwaysInclude must be a list of instance-relative file paths"]);
  });

  it("accepts a minimal valid config", () => {
    expect(validateConfigShape({ engines: { claude: { bin: "claude", model: "opus" } } })).toEqual([]);
  });

  it("accepts a full default-shaped config", () => {
    expect(validateConfigShape({
      jinn: { version: "1.0.0" },
      gateway: { port: 7777, host: "127.0.0.1" },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" } },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    })).toEqual([]);
  });

  it("accepts a config without a gateway block (downstream defaults apply)", () => {
    expect(validateConfigShape({ engines: { claude: {} } })).toEqual([]);
  });

  it("rejects null / empty files", () => {
    expect(validateConfigShape(null)).toHaveLength(1);
    expect(validateConfigShape(undefined)).toHaveLength(1);
  });

  it("rejects a config that parsed to a scalar or array", () => {
    expect(validateConfigShape("oops")[0]).toContain("expected a YAML mapping");
    expect(validateConfigShape([1, 2])[0]).toContain("expected a YAML mapping");
  });

  it("rejects a non-numeric gateway.port", () => {
    const problems = validateConfigShape({ gateway: { port: "7777" }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.port"))).toBe(true);
  });

  it("accepts a boolean gateway.notesEnabled flag and rejects other values", () => {
    expect(validateConfigShape({ gateway: { notesEnabled: false }, engines: { claude: {} } })).toEqual([]);
    const problems = validateConfigShape({ gateway: { notesEnabled: "false" }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.notesEnabled"))).toBe(true);
  });

  it("accepts gateway.todoRecovery.mode and rejects unknown values", () => {
    expect(validateConfigShape({ gateway: { todoRecovery: { mode: "classify-only" } }, engines: { claude: {} } })).toEqual([]);
    expect(validateConfigShape({ gateway: { todoRecovery: { mode: "auto" } }, engines: { claude: {} } })).toEqual([]);
    expect(validateConfigShape({ gateway: { todoRecovery: { mode: "off" } }, engines: { claude: {} } })).toEqual([]);
    const problems = validateConfigShape({ gateway: { todoRecovery: { mode: "always" } }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.todoRecovery.mode"))).toBe(true);
  });

  it("accepts a boolean gateway.resumeInterruptedSessions flag and rejects other values", () => {
    expect(validateConfigShape({ gateway: { resumeInterruptedSessions: false }, engines: { claude: {} } })).toEqual([]);
    expect(validateConfigShape({ gateway: {}, engines: { claude: {} } })).toEqual([]);
    const problems = validateConfigShape({ gateway: { resumeInterruptedSessions: "no" }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.resumeInterruptedSessions"))).toBe(true);
  });

  it("rejects missing engines / engines.claude", () => {
    expect(validateConfigShape({})[0]).toContain("engines");
    const problems = validateConfigShape({ engines: { default: "codex" } });
    expect(problems.some((p) => p.includes("engines.claude"))).toBe(true);
  });
});

describe("saveConfigAtomic", () => {
  // CONFIG_PATH is resolved at module load from process.env.JINN_HOME, so we
  // point it at a temp dir and re-import the module (same pattern as the cron
  // jobs tests).
  let tmpHome: string;
  const prevHome = process.env.JINN_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-save-"));
    process.env.JINN_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = prevHome;
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes valid YAML to config.yaml and leaves no tmp file behind", async () => {
    const { saveConfigAtomic } = await import("../config.js");
    const configPath = path.join(tmpHome, "config.yaml");
    const cfg = { gateway: { port: 7999 }, talk: { engine: "claude", note: "x".repeat(200) } };

    saveConfigAtomic(cfg, { lineWidth: -1 });

    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual(cfg);
    // lineWidth: -1 → the long string must not be folded across lines
    expect(fs.readFileSync(configPath, "utf-8")).toContain("x".repeat(200));
    expect(fs.readdirSync(tmpHome).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("replaces an existing config.yaml", async () => {
    const { saveConfigAtomic } = await import("../config.js");
    const configPath = path.join(tmpHome, "config.yaml");
    fs.writeFileSync(configPath, "old: true\n");

    saveConfigAtomic({ fresh: 1 });

    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({ fresh: 1 });
  });

  it("creates and replaces config.yaml with owner-only permissions", async () => {
    const { saveConfigAtomic } = await import("../config.js");
    const configPath = path.join(tmpHome, "config.yaml");

    saveConfigAtomic({ fresh: 1 });
    expectPosixMode(configPath, 0o600);

    fs.chmodSync(configPath, 0o600);
    saveConfigAtomic({ fresh: 2 });
    expectPosixMode(configPath, 0o600);
  });
});

describe("a stale workflows block from before Workflows were removed", () => {
  // CONFIG_PATH is resolved at module load, so each case re-imports the module
  // against its own home (same pattern as saveConfigAtomic above).
  let tmpHome: string;
  const prevHome = process.env.JINN_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-stale-workflows-"));
    process.env.JINN_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = prevHome;
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("loads without error and keeps the block as written", async () => {
    const { loadConfig } = await import("../config.js");
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7777 },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
      workflows: { armingDelegates: ["a"], delivery: { branch: "main" } },
    }));

    const config = loadConfig();

    expect(config.workflows).toEqual({ armingDelegates: ["a"], delivery: { branch: "main" } });
  });

  it("is still an allowed top-level key, so a PUT /api/config round-trip keeps it", async () => {
    const { CONFIG_TOP_LEVEL_KEYS } = await import("../config.js");

    expect(CONFIG_TOP_LEVEL_KEYS).toContain("workflows");
  });
});

describe("validateConfigShape — engine fallback chains", () => {
  it("accepts an ordered chain of known engines and an explicitly empty one", () => {
    expect(validateConfigShape({ engines: { claude: { fallback: ["codex", "grok"] } } })).toEqual([]);
    expect(validateConfigShape({ engines: { claude: { fallback: [] } } })).toEqual([]);
  });

  it("names the path, the bad value and the known engines when a chain names an unknown engine", () => {
    const problems = validateConfigShape({ engines: { claude: { fallback: ["gpt4"] } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("engines.claude.fallback[0]");
    expect(problems[0]).toContain('"gpt4"');
    expect(problems[0]).toContain("claude, codex, antigravity, grok, pi, hermes");
  });

  it("refuses a self-referencing chain, naming the path", () => {
    const problems = validateConfigShape({ engines: { claude: { fallback: ["claude"] } } });
    expect(problems).toEqual(["engines.claude.fallback must not name claude itself"]);
  });

  it("refuses a chain that is not a list, and one with a non-string member", () => {
    expect(validateConfigShape({ engines: { claude: { fallback: "codex" } } }))
      .toEqual(["engines.claude.fallback must be a list of engine names (got string)"]);
    expect(validateConfigShape({ engines: { claude: { fallback: [3] } } }))
      .toEqual(["engines.claude.fallback[0] must be a string (got number)"]);
  });

  it("accepts a cycle across engines — the runtime walker's visited set handles those", () => {
    expect(validateConfigShape({
      engines: { claude: { fallback: ["codex"] }, codex: { fallback: ["claude"] } },
    })).toEqual([]);
  });

  it("reports nothing for a config carrying no fallback key at all", () => {
    expect(validateConfigShape({
      engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" } },
      sessions: { rateLimitStrategy: "fallback", fallbackEngine: "codex" },
    })).toEqual([]);
  });
});
