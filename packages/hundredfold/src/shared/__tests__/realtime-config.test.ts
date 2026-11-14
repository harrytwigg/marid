import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { resolveEnvVar } from "../env-ref.js";
import type { HundredfoldConfig } from "../types.js";

const ENV_VAR = "HUNDREDFOLD_TEST_REALTIME_CONFIG_KEY";

const BASE_CONFIG = {
  gateway: { port: 7999, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
};

describe("resolveEnvVar", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("resolves ${VAR} from the environment", () => {
    process.env[ENV_VAR] = "sk-from-env";
    expect(resolveEnvVar(`\${${ENV_VAR}}`)).toBe("sk-from-env");
  });

  it("resolves a bare $VAR from the environment", () => {
    process.env[ENV_VAR] = "sk-from-env";
    expect(resolveEnvVar(`$${ENV_VAR}`)).toBe("sk-from-env");
  });

  it("returns undefined rather than the literal reference when the variable is unset", () => {
    expect(resolveEnvVar(`\${${ENV_VAR}}`)).toBeUndefined();
  });

  it("passes a plain value through untouched", () => {
    expect(resolveEnvVar("sk-literal")).toBe("sk-literal");
  });

  it("treats an absent value as absent", () => {
    expect(resolveEnvVar(undefined)).toBeUndefined();
    expect(resolveEnvVar("")).toBeUndefined();
  });
});

describe("the realtime config block", () => {
  // CONFIG_PATH is resolved at module load from process.env.HUNDREDFOLD_HOME, so we
  // point it at a temp dir and re-import the module (same pattern as the
  // saveConfigAtomic tests above).
  let tmpHome: string;
  const prevHome = process.env.HUNDREDFOLD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-realtime-config-"));
    process.env.HUNDREDFOLD_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
    else process.env.HUNDREDFOLD_HOME = prevHome;
    delete process.env[ENV_VAR];
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function loadWritten(config: unknown): Promise<HundredfoldConfig> {
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump(config), "utf-8");
    const { loadConfig } = await import("../config.js");
    return loadConfig();
  }

  it("loads a config.yaml that carries it", async () => {
    const loaded = await loadWritten({
      ...BASE_CONFIG,
      realtime: {
        provider: "openai",
        model: "gpt-realtime",
        apiKey: `\${${ENV_VAR}}`,
        voice: "marin",
        turnDetection: "none",
      },
    });

    expect(loaded.realtime).toEqual({
      provider: "openai",
      model: "gpt-realtime",
      apiKey: `\${${ENV_VAR}}`,
      voice: "marin",
      turnDetection: "none",
    });
  });

  it("loads a config.yaml that omits it", async () => {
    const loaded = await loadWritten(BASE_CONFIG);

    expect(loaded.realtime).toBeUndefined();
    expect(loaded.engines.claude.model).toBe("opus");
  });

  it("keeps the key out of config.yaml and resolves it from the environment at use", async () => {
    process.env[ENV_VAR] = "sk-from-env";
    const loaded = await loadWritten({ ...BASE_CONFIG, realtime: { provider: "openai", apiKey: `\${${ENV_VAR}}` } });

    const onDisk = fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8");
    expect(onDisk).not.toContain("sk-from-env");
    expect(resolveEnvVar(loaded.realtime?.apiKey)).toBe("sk-from-env");
  });
});
