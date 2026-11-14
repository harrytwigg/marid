import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setOpencodeAccountKeyEnv } from "../child-env.js";
import { discoverClaudeEffortLevels } from "../claude-models.js";
import { discoverCodexModels } from "../codex-models.js";
import { discoverGrokModels } from "../grok-models.js";
import { discoverAntigravityModels } from "../antigravity-models.js";
import { discoverHermesModels } from "../hermes-models.js";
import { runLocalWakeCommand } from "../../engines/remote-wake.js";

/** Every child the gateway starts that is not an opencode process: model discovery, wake commands and the like. None holds an account's key. */
describe.skipIf(process.platform === "win32")("account keys in non-opencode children", () => {
  let dir: string;
  let bin: string;
  const seen = () => path.join(dir, "seen");
  const KEY = "ACME_KEY_A";
  const OTHER = "ACME_KEY_UNDECLARED";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-key-children-"));
    bin = path.join(dir, "fake-engine");
    fs.writeFileSync(bin, `#!/bin/sh\nenv > "${path.join(dir, "seen")}"\nexit 0\n`, { mode: 0o755 });
    setOpencodeAccountKeyEnv([KEY]);
    process.env[KEY] = "sk-secret-a";
    process.env[OTHER] = "kept";
  });

  afterAll(() => {
    setOpencodeAccountKeyEnv([]);
    delete process.env[KEY];
    delete process.env[OTHER];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["claude help discovery", () => discoverClaudeEffortLevels(bin)],
    ["codex model discovery", () => discoverCodexModels(bin)],
    ["grok model discovery", () => discoverGrokModels(bin)],
    ["antigravity model discovery", () => discoverAntigravityModels(bin)],
    ["hermes model discovery", () => discoverHermesModels(bin)],
    ["a wake command", () => runLocalWakeCommand(`"${bin}"`, 5000)],
  ];

  it.each(cases)("%s runs without the key", async (_name, run) => {
    fs.rmSync(seen(), { force: true });
    await run().catch(() => undefined);
    const printed = fs.readFileSync(seen(), "utf8");
    expect(printed).toContain(`${OTHER}=kept`);
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain("sk-secret-a");
  });
});
