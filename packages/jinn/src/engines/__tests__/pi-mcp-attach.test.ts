import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { McpGlobalConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../../shared/types.js";
import { makeFakeProc, flush, agentEnd, type SpawnCall } from "./support/pi-spawn-harness.js";

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

import { PiEngine } from "../pi.js";
import { logger } from "../../shared/logger.js";
import { JINN_HOME } from "../../shared/paths.js";
import { resolveMcpServers } from "../../mcp/resolver.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { attachSessionIdentity } from "../../mcp/identity.js";

/**
 * The jinn belt reaches pi as a per-session `--extension` module while the session's
 * identity and the gateway credentials ride pi's child env. Neither end was pinned
 * from `run()`: pi employees were found starting with no company tools at all,
 * nobody being told, and the whole suite green.
 */
describe("PiEngine — jinn MCP attachment", () => {
  const GATEWAY_URL = "http://127.0.0.1:56789";
  const TOKEN = "pi-attach-test-token";
  const SID = "jinn-pi-mcp";
  const MCP_ON = { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig;

  let envBackup: Record<string, string | undefined>;
  beforeEach(() => {
    spawnCalls.length = 0;
    envBackup = { JINN_GATEWAY_URL: process.env.JINN_GATEWAY_URL, JINN_GATEWAY_TOKEN: process.env.JINN_GATEWAY_TOKEN };
    process.env.JINN_GATEWAY_URL = GATEWAY_URL;
    process.env.JINN_GATEWAY_TOKEN = TOKEN;
    // The resolver only attaches the belt behind an armed-ok smoke gate (unarmed
    // fails closed); a booted gateway arms it, so this suite does.
    setJinnAttachGate({ ok: true });
  });
  afterEach(() => {
    setJinnAttachGate(null);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  /** The real resolver payload a pi session gets when the belt is on. */
  const attachedMcp = () => attachSessionIdentity(resolveMcpServers(MCP_ON, undefined, "pi"), SID);

  async function runWithMcp(resolvedMcp: ResolvedMcpConfig | undefined) {
    const engine = new PiEngine();
    const promise = engine.run({ prompt: "hello", cwd: "/tmp", sessionId: SID, model: "forge/qwen3.8-27b", resolvedMcp });
    await flush();
    const call = spawnCalls[spawnCalls.length - 1]!;
    return {
      call,
      // Settling the run deletes the extension dir, so assert before finishing.
      finish: async () => {
        call.proc.emitStdout(agentEnd("ok") + "\n");
        await flush();
        call.proc.close(0);
        await promise;
      },
    };
  }

  it("passes the generated extension file to pi as --extension", async () => {
    const { call, finish } = await runWithMcp(attachedMcp());

    const flagIndex = call.args.indexOf("--extension");
    expect(flagIndex).toBeGreaterThan(-1);
    const extensionPath = call.args[flagIndex + 1]!;
    expect(fs.existsSync(extensionPath)).toBe(true);
    expect(fs.readFileSync(extensionPath, "utf-8")).toContain("registerTool");

    await finish();
  });

  it("attaches nothing when the resolved set carries no jinn server", async () => {
    const extensionDir = path.join(JINN_HOME, "tmp", "pi-mcp", SID);
    fs.rmSync(extensionDir, { recursive: true, force: true });

    const { call, finish } = await runWithMcp({ mcpServers: {} });

    expect(call.args).not.toContain("--extension");
    expect(fs.existsSync(extensionDir)).toBe(false);

    await finish();
  });

  it("warns when the belt was resolved but pi cannot wire it, and stays quiet when it attaches", async () => {
    const warnings: string[] = [];
    vi.spyOn(logger, "warn").mockImplementation((message: string) => { warnings.push(message); });

    const unwirable = await runWithMcp({ mcpServers: { jinn: { type: "sse", url: "https://mcp.example/jinn" } } });
    expect(unwirable.call.args).not.toContain("--extension");
    const warning = warnings.find((message) => message.includes("jinn toolset"));
    expect(warning).toBeDefined();
    expect(warning).toContain("Pi engine");
    expect(warning).toContain(SID);
    expect(warning).toContain("URL-based");
    await unwirable.finish();

    warnings.length = 0;
    const attached = await runWithMcp(attachedMcp());
    expect(attached.call.args).toContain("--extension");
    expect(warnings.filter((message) => message.includes("jinn toolset"))).toEqual([]);
    await attached.finish();
  });

  it("hands pi the gateway credentials and session capability the extension reads at tool-call time", async () => {
    const resolved = attachedMcp();
    const { call, finish } = await runWithMcp(resolved);

    // The extension reads all four straight from process.env, with no gateway.json
    // fallback of its own — scrub any of them and every pi tool call 401s silently.
    const env = (call.opts as { env: Record<string, string> }).env;
    expect(env.JINN_GATEWAY_TOKEN).toBe(TOKEN);
    expect(env.JINN_GATEWAY_URL).toBe(GATEWAY_URL);
    expect(env.JINN_SESSION_ID).toBe(SID);
    expect(env.JINN_SESSION_CAPABILITY).toBe((resolved.mcpServers.jinn as McpServerStdioConfig).env?.JINN_SESSION_CAPABILITY);

    await finish();
  });
});
