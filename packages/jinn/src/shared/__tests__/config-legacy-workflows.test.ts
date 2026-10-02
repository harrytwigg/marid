import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

describe("a legacy workflows block in config.yaml", () => {
  // CONFIG_PATH is resolved at module load, so each case re-imports the module
  // against its own home.
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
