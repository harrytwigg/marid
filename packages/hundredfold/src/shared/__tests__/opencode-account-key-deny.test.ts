import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

/** An account's key variable stays out of every child but the opencode processes that serve the account. */
describe("opencode account key variables", () => {
  let tmpHome: string;
  const prevHome = process.env.HUNDREDFOLD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-account-key-deny-"));
    process.env.HUNDREDFOLD_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
    else process.env.HUNDREDFOLD_HOME = prevHome;
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const writeConfig = (accounts: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7778, host: "127.0.0.1" },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" }, opencode: { bin: "opencode", model: "x/y", accounts } },
    }));
  };

  it("loading the config makes every engine child env drop the declared keys, and a reload follows the new declaration", async () => {
    const { loadConfig } = await import("../config.js");
    const { buildEngineChildEnv } = await import("../child-env.js");
    const environment = { PATH: "/usr/bin", GO_B_KEY: "sk-b", GO_C_KEY: "sk-c" };
    writeConfig({ b: { provider: "go-b", base: "go", keyEnv: "GO_B_KEY" }, builtin: { provider: "go" } });
    loadConfig();
    for (const options of [{ scrubClaudeCode: true }, { scrubCodex: true }, { scopedSession: true }, {}]) {
      const env = buildEngineChildEnv(environment, options);
      expect(env).not.toHaveProperty("GO_B_KEY");
      expect(env.GO_C_KEY).toBe(options.scopedSession ? undefined : "sk-c");
    }
    writeConfig({ c: { provider: "go-c", base: "go", keyEnv: "GO_C_KEY" } });
    loadConfig();
    const env = buildEngineChildEnv(environment, {});
    expect(env.GO_B_KEY).toBe("sk-b");
    expect(env).not.toHaveProperty("GO_C_KEY");
  });

  it("the opencode --version probe runs without the keys", async () => {
    if (process.platform === "win32") return;
    const { loadConfig } = await import("../config.js");
    const { localOpencodeVersion, clearOpencodeVersionCache } = await import("../opencode-bin-version.js");
    writeConfig({ b: { provider: "go-b", base: "go", keyEnv: "GO_B_KEY" } });
    loadConfig();
    const seen = path.join(tmpHome, "seen-env");
    const bin = path.join(tmpHome, "fake-opencode");
    fs.writeFileSync(bin, `#!/bin/sh\nenv > "${seen}"\necho "opencode v2.0.32"\n`, { mode: 0o755 });
    process.env.GO_B_KEY = "sk-probe-secret";
    try {
      clearOpencodeVersionCache();
      expect(await localOpencodeVersion(bin)).toBe("2.0.32");
    } finally {
      delete process.env.GO_B_KEY;
    }
    const printed = fs.readFileSync(seen, "utf8");
    expect(printed).toContain("PATH=");
    expect(printed).not.toContain("GO_B_KEY");
    expect(printed).not.toContain("sk-probe-secret");
  });
});
