// packages/hundredfold/src/mcp/__tests__/engine-wiring.test.ts
/**
 * GRS-018 item 5 — the per-engine wiring seam for the GRS-017 default-on
 * decision (designed in parallel; NOT flipped here).
 *
 * One REAL resolver payload (mcp.gateway.enabled === true) is driven through
 * every MCP-capable engine's attach translation, pinning per engine:
 *   1. the hundredfold server reaches the engine's per-session attach artifact, and
 *   2. the engine's secret-channel contract holds:
 *        claude — temp-file JSON carries the spec verbatim (URL env only);
 *        codex  — argv `-c` overrides, allowlisted env only, NEVER the token;
 *        grok   — marker-guarded project TOML, allowlisted env only, NEVER
 *                 the token;
 *        hermes — in-memory ACP array; the ONLY channel that carries the
 *                 token (hermes filters inherited env for MCP subprocesses,
 *                 and the ACP stdin pipe never touches disk/argv).
 * And the OFF position: without the opt-in, every adapter produces a no-op —
 * so when GRS-017 flips the default, the only intended change is the
 * resolver's gate, and any adapter-level surprise fails one of these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile, MCP_CAPABLE_ENGINES } from "../resolver.js";
import { setHundredfoldAttachGate } from "../attachment.js";
import {
  HUNDREDFOLD_SESSION_CAPABILITY_ENV,
  attachSessionIdentity,
} from "../identity.js";
import { resolveMcpServerBootstrap } from "../server-bootstrap.js";
import { codexMcpConfigArgs, prepareCodexSessionHome } from "../../engines/codex.js";
import { prepareGrokProjectMcpConfig, cleanupGrokProjectMcpConfig, grokHundredfoldSessionEnv, HUNDREDFOLD_GROK_MCP_MARKER } from "../../engines/grok-mcp.js";
import { buildAcpMcpServers } from "../../engines/hermes-mcp.js";
import { writePiHundredfoldMcpExtension, cleanupPiHundredfoldMcpExtension, piHundredfoldSessionEnv } from "../../engines/pi-mcp.js";
import {
  ensureAntigravityHundredfoldMcpConfig,
  antigravityHundredfoldSessionEnv,
  ANTIGRAVITY_HUNDREDFOLD_MCP_MARKER,
} from "../../engines/antigravity-mcp.js";
import type { McpGlobalConfig } from "../../shared/types.js";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";

const GATEWAY_URL = "http://127.0.0.1:56789";
const TOKEN = "wiring-test-secret-token";
const ON: McpGlobalConfig = { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig;
const OFF: McpGlobalConfig = { browser: { enabled: false } } as McpGlobalConfig;

let envBackup: Record<string, string | undefined>;
beforeEach(() => {
  envBackup = { HUNDREDFOLD_GATEWAY_URL: process.env.HUNDREDFOLD_GATEWAY_URL, HUNDREDFOLD_GATEWAY_TOKEN: process.env.HUNDREDFOLD_GATEWAY_TOKEN };
  process.env.HUNDREDFOLD_GATEWAY_URL = GATEWAY_URL;
  process.env.HUNDREDFOLD_GATEWAY_TOKEN = TOKEN;
  // GRS-017e-fix: the resolver only attaches hundredfold behind an armed-ok smoke
  // gate (unarmed fails closed); a booted gateway arms it, so wiring tests do.
  setHundredfoldAttachGate({ ok: true });
});
afterEach(() => {
  setHundredfoldAttachGate(null);
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("per-engine hundredfold-server wiring (GRS-018 seam for GRS-017 default-on)", () => {
  it("covers every MCP-capable engine (fails when the set grows without a wiring test here)", () => {
    // If a new engine joins MCP_CAPABLE_ENGINES, add its attach-artifact case and
    // extend this list. opencode's is in engines/__tests__/opencode-mcp.test.ts, musecode's in musecode-mcp.test.ts.
    expect([...MCP_CAPABLE_ENGINES].sort()).toEqual(["antigravity", "claude", "codex", "grok", "hermes", "musecode", "opencode", "pi"]);
  });

  it("claude: temp-file JSON carries the hundredfold spec verbatim, non-secret env only, and cleans up", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const p = writeMcpConfigFile(resolved, "wiring-claude");
    try {
      expectPosixMode(fs.statSync(p), 0o600);
      const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
      expect(onDisk.mcpServers.hundredfold.command).toBeTruthy();
      // GRS-018 unified builtin env: URL + HUNDREDFOLD_HOME (token-fallback hint) —
      // both non-secret; the bearer itself must never appear in the file.
      expect(onDisk.mcpServers.hundredfold.env.HUNDREDFOLD_GATEWAY_URL).toBe(GATEWAY_URL);
      expect(typeof onDisk.mcpServers.hundredfold.env.HUNDREDFOLD_HOME).toBe("string");
      expect(fs.readFileSync(p, "utf-8")).not.toContain(TOKEN);
    } finally {
      cleanupMcpConfigFile("wiring-claude");
    }
    expect(fs.existsSync(p)).toBe(false);
  });

  it("codex: -c argv overrides carry the hundredfold server with allowlisted env, NEVER the token", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const args = codexMcpConfigArgs(resolved);
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.hundredfold.command=");
    expect(joined).toContain(`HUNDREDFOLD_GATEWAY_URL=${JSON.stringify(GATEWAY_URL)}`);
    expect(joined).not.toContain(TOKEN);
  });

  it("grok: marker-guarded project TOML carries the hundredfold server with allowlisted env, NEVER the token", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-grok-"));
    try {
      const handle = prepareGrokProjectMcpConfig(cwd, resolved);
      expect(handle.attached).toBe(true);
      if (handle.attached) {
        const toml = fs.readFileSync(handle.configPath, "utf-8");
        expect(toml.startsWith(HUNDREDFOLD_GROK_MCP_MARKER)).toBe(true);
        expect(toml).toContain("[mcp_servers.hundredfold]");
        expect(toml).toContain(`HUNDREDFOLD_GATEWAY_URL = ${JSON.stringify(GATEWAY_URL)}`);
        expect(toml).not.toContain(TOKEN);
        cleanupGrokProjectMcpConfig(handle);
        expect(fs.existsSync(handle.configPath)).toBe(false);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("hermes: ACP wire array carries the hundredfold server WITH the token (the one in-memory channel)", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const wire = buildAcpMcpServers(resolved);
    const hundredfold = wire.find((s) => s.name === "hundredfold");
    expect(hundredfold).toBeDefined();
    expect(hundredfold!.env).toContainEqual({ name: "HUNDREDFOLD_GATEWAY_URL", value: GATEWAY_URL });
    expect(hundredfold!.env).toContainEqual({ name: "HUNDREDFOLD_GATEWAY_TOKEN", value: TOKEN });
  });

  // GRS-018 unified required-env model (GRS-017 QA critical 1): the builtin
  // hundredfold server needs URL + caller identity (HUNDREDFOLD_SESSION_ID), the bound
  // per-session capability (HUNDREDFOLD_SESSION_CAPABILITY), and a token path
  // (HUNDREDFOLD_HOME → gateway.json fallback) to reach it under EVERY engine. This
  // block drives ONE identity-stamped payload (the exact shape manager.ts
  // threads) through each adapter and pins where each required key rides.
  describe("identity-stamped payload: HUNDREDFOLD_SESSION_ID + capability + HUNDREDFOLD_HOME reach the builtin per engine", () => {
    const SID = "sess-wiring-0123";
    const stamped = () => attachSessionIdentity(resolveMcpServers(ON, undefined), SID);
    const capabilityOf = (resolved: ReturnType<typeof stamped>) =>
      (resolved.mcpServers.hundredfold as { env?: Record<string, string> }).env?.[HUNDREDFOLD_SESSION_CAPABILITY_ENV];

    it("claude: the per-session temp file carries the session id + capability (per-session file)", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const p = writeMcpConfigFile(resolved, "wiring-claude-sid");
      try {
        expectPosixMode(fs.statSync(p), 0o600);
        expect(path.basename(path.dirname(p))).toBe("wiring-claude-sid");
        const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
        expect(onDisk.mcpServers.hundredfold.env.HUNDREDFOLD_SESSION_ID).toBe(SID);
        expect(onDisk.mcpServers.hundredfold.env.HUNDREDFOLD_SESSION_CAPABILITY).toBe(capability);
        const bootstrap = resolveMcpServerBootstrap(onDisk.mcpServers.hundredfold.args);
        expect(bootstrap).toMatchObject({
          callerSessionId: SID,
          sessionCapability: capability,
          gatewayUrl: GATEWAY_URL,
          hundredfoldHome: expect.any(String),
        });
      } finally {
        cleanupMcpConfigFile("wiring-claude-sid");
      }
    });

    it("the one session launch path uses the identity-stamping resolver", () => {
      // The two runners each launched their own engine and this guarded both
      // copies; they now share one turn, so it guards that path — and that
      // neither runner has grown a launch of its own back.
      const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf-8");
      const preflight = read("../../sessions/turn/preflight.ts");
      expect(preflight).toContain("resolveEngineRunMcp({");
      expect(preflight).toMatch(/sessionId:\s*session\.id/);
      expect(read("../../sessions/turn/engine-run.ts")).toMatch(/engine\.run\(\{[\s\S]*?resolvedMcp:/);
      for (const rel of ["../../sessions/manager.ts", "../../gateway/api.ts"]) {
        expect(read(rel)).not.toMatch(/engine\.run\(/);
      }
    });

    it("codex: argv never carries the capability; the per-session CODEX_HOME config.toml (0600) carries the bound hundredfold env", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const args = codexMcpConfigArgs(resolved);
      expect(args.join(" ")).not.toContain(String(capability));
      expect(args.join(" ")).not.toContain("HUNDREDFOLD_SESSION_CAPABILITY");

      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-wiring-"));
      const home = prepareCodexSessionHome(resolved, SID, { baseDir });
      expect(home).toBeDefined();
      try {
        const cfgPath = path.join(home!.home, "config.toml");
        expectPosixMode(fs.statSync(cfgPath), 0o600);
        const toml = fs.readFileSync(cfgPath, "utf-8");
        expect(toml).toContain(`HUNDREDFOLD_GATEWAY_URL = ${JSON.stringify(GATEWAY_URL)}`);
        expect(toml).toContain(`HUNDREDFOLD_SESSION_ID = ${JSON.stringify(SID)}`);
        expect(toml).toContain(`HUNDREDFOLD_SESSION_CAPABILITY = ${JSON.stringify(capability)}`);
        expect(toml).toContain("HUNDREDFOLD_HOME = ");
        expect(toml).not.toContain(TOKEN);
      } finally {
        home?.cleanup();
      }
      expect(home && fs.existsSync(home.home)).toBe(false);
    });

    it("codex: the wider allowlist is a BUILTIN privilege — a third-party spec smuggling the same keys stays URL-only", () => {
      const sneaky = {
        mcpServers: {
          thirdparty: {
            command: "npx",
            args: [],
            env: { HUNDREDFOLD_GATEWAY_URL: "http://x", HUNDREDFOLD_SESSION_ID: "spoof", HUNDREDFOLD_SESSION_CAPABILITY: "spoof-cap", HUNDREDFOLD_HOME: "/tmp/x" },
          },
        },
      };
      const env = codexMcpConfigArgs(sneaky).find((a) => a.startsWith("mcp_servers.thirdparty.env="))!;
      expect(env).toContain("HUNDREDFOLD_GATEWAY_URL=");
      expect(env).not.toContain("HUNDREDFOLD_SESSION_ID");
      expect(env).not.toContain("HUNDREDFOLD_SESSION_CAPABILITY");
      expect(env).not.toContain("HUNDREDFOLD_HOME");
    });

    it("grok: the SHARED config stays byte-identical; identity + capability ride the child env instead", () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-grok-sid-"));
      try {
        const handle = prepareGrokProjectMcpConfig(cwd, stamped());
        expect(handle.attached).toBe(true);
        if (handle.attached) {
          const toml = fs.readFileSync(handle.configPath, "utf-8");
          expect(toml).not.toContain(SID);            // per-session value NEVER in the shared file
          expect(toml).toContain("HUNDREDFOLD_HOME = ");     // process-global → byte-stable, allowed
          // A second concurrent session with a DIFFERENT id produces the same bytes.
          const other = prepareGrokProjectMcpConfig(cwd, attachSessionIdentity(resolveMcpServers(ON, undefined), "sess-other"));
          expect(other.attached).toBe(true);
          expect(fs.readFileSync(handle.configPath, "utf-8")).toBe(toml);
          cleanupGrokProjectMcpConfig(other);
          cleanupGrokProjectMcpConfig(handle);
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
      // The child-env shim delivers the id (grok forwards full env to its MCP servers).
      const resolved = stamped();
      expect(grokHundredfoldSessionEnv(resolved)).toEqual({
        HUNDREDFOLD_SESSION_ID: SID,
        HUNDREDFOLD_SESSION_CAPABILITY: capabilityOf(resolved),
      });
      expect(grokHundredfoldSessionEnv(resolveMcpServers(ON, undefined))).toEqual({});
      expect(grokHundredfoldSessionEnv(undefined)).toEqual({});
    });

    it("hermes: the ACP wire carries the session id + capability (full spec env passes through)", () => {
      const resolved = stamped();
      const wire = buildAcpMcpServers(resolved);
      const hundredfold = wire.find((s) => s.name === "hundredfold")!;
      expect(hundredfold.env).toContainEqual({ name: "HUNDREDFOLD_SESSION_ID", value: SID });
      expect(hundredfold.env).toContainEqual({ name: "HUNDREDFOLD_SESSION_CAPABILITY", value: capabilityOf(resolved) });
      expect(hundredfold.env.some((e) => e.name === "HUNDREDFOLD_HOME")).toBe(true);
    });

    it("pi: a per-session extension file registers the hundredfold tools while identity rides the child env", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const handle = writePiHundredfoldMcpExtension(resolved, SID);
      expect(handle.attached).toBe(true);
      try {
        if (!handle.attached) throw new Error("expected pi MCP extension to attach");
        expectPosixMode(fs.statSync(handle.extensionPath), 0o600);
        const source = fs.readFileSync(handle.extensionPath, "utf-8");
        expect(source).toContain("registerTool");
        expect(source).toContain("buildTools");
        expect(source).not.toContain(TOKEN);
        expect(source).not.toContain(SID);
        expect(source).not.toContain(String(capability));
      } finally {
        cleanupPiHundredfoldMcpExtension(handle);
      }
      expect(handle.attached && fs.existsSync(handle.extensionPath)).toBe(false);
      expect(piHundredfoldSessionEnv(resolved)).toEqual({
        HUNDREDFOLD_SESSION_ID: SID,
        HUNDREDFOLD_SESSION_CAPABILITY: capability,
      });
      expect(piHundredfoldSessionEnv(resolveMcpServers(ON, undefined))).toEqual({});
      expect(piHundredfoldSessionEnv(undefined)).toEqual({});
    });

    it("antigravity: guarded Gemini config carries only process-global hundredfold MCP data; identity rides the child env", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-antigravity-"));
      const configPath = path.join(tmp, "mcp_config.json");
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { search: { command: "search-cli" } } }));
      try {
        const handle = ensureAntigravityHundredfoldMcpConfig(resolved, { configPath });
        expect(handle.attached).toBe(true);
        const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        expect(json.mcpServers.search.command).toBe("search-cli");
        expect(json.mcpServers.hundredfold.command).toBeTruthy();
        expect(json.mcpServers.hundredfold.env.HUNDREDFOLD_GATEWAY_URL).toBe(GATEWAY_URL);
        expect(json.mcpServers.hundredfold.env.HUNDREDFOLD_MCP_MANAGED_BY).toBe(ANTIGRAVITY_HUNDREDFOLD_MCP_MARKER);
        const onDisk = fs.readFileSync(configPath, "utf-8");
        expect(onDisk).not.toContain(TOKEN);
        expect(onDisk).not.toContain(SID);
        expect(onDisk).not.toContain(String(capability));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      expect(antigravityHundredfoldSessionEnv(resolved)).toEqual({
        HUNDREDFOLD_SESSION_ID: SID,
        HUNDREDFOLD_SESSION_CAPABILITY: capability,
      });
      expect(antigravityHundredfoldSessionEnv(resolveMcpServers(ON, undefined))).toEqual({});
      expect(antigravityHundredfoldSessionEnv(undefined)).toEqual({});
    });
  });

  it("explicit kill switch keeps every adapter a no-op for hundredfold", () => {
    const resolved = resolveMcpServers({ ...OFF, gateway: { enabled: false } }, undefined);
    expect(resolved.mcpServers.hundredfold).toBeUndefined();

    // codex: no hundredfold override in argv.
    expect(codexMcpConfigArgs(resolved).join(" ")).not.toContain("mcp_servers.hundredfold");

    // grok: attach declines outright.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-grok-off-"));
    try {
      expect(prepareGrokProjectMcpConfig(cwd, resolved)).toEqual({ attached: false });
      expect(fs.existsSync(path.join(cwd, ".grok"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }

    // hermes: no hundredfold entry on the ACP wire (and thus no token anywhere).
    expect(buildAcpMcpServers(resolved).find((s) => s.name === "hundredfold")).toBeUndefined();

    // claude: the temp file simply carries no hundredfold server.
    const p = writeMcpConfigFile(resolved, "wiring-claude-off");
    try {
      expect(JSON.parse(fs.readFileSync(p, "utf-8")).mcpServers.hundredfold).toBeUndefined();
    } finally {
      cleanupMcpConfigFile("wiring-claude-off");
    }
  });
});
