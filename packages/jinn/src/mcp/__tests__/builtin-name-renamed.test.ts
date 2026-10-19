import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": everything derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import type { Employee, McpGlobalConfig, ResolvedMcpConfig } from "../../shared/types.js";
import { builtinMcpNames, builtinMcpServerName, findBuiltinMcp, isBuiltinMcpName } from "../builtin-name.js";
import { resolveMcpServers } from "../resolver.js";
import { setJinnAttachGate } from "../attachment.js";
import { attachSessionIdentity } from "../identity.js";
import { confineMcpToDepartment } from "../../gateway/department-scope/mcp-servers.js";
import { prepareGrokProjectMcpConfig, cleanupGrokProjectMcpConfig } from "../../engines/grok-mcp.js";
import { ensureAntigravityJinnMcpConfig } from "../../engines/antigravity-mcp.js";
import { prepareCodexSessionHome } from "../../engines/codex.js";
import { boardWalkAgentPermission } from "../../engines/opencode-mcp.js";

const GATEWAY_ON: McpGlobalConfig = { gateway: { enabled: true } };
const employee = (over: Partial<Employee> = {}): Employee => ({ name: "e", displayName: "E", department: "d", rank: "employee", engine: "claude", model: "sonnet", persona: "p", ...over });

describe("the built-in MCP server's name", () => {
  it("is the legacy name until the instance records its own, and both names are reserved", () => {
    expect(builtinMcpNames()).toEqual(["acme", "jinn"]);
    expect(builtinMcpServerName({})).toBe("jinn");
    expect(builtinMcpServerName({ jinn: { version: "1.0.0" } })).toBe("jinn");
    expect(builtinMcpServerName({ acme: { mcpServerName: "acme" } })).toBe("acme");
    expect(builtinMcpServerName({ jinn: { mcpServerName: "acme" } })).toBe("acme");
    expect(builtinMcpServerName({ acme: { mcpServerName: "other" } })).toBe("jinn");
    expect(isBuiltinMcpName("jinn")).toBe(true);
    expect(isBuiltinMcpName("acme")).toBe(true);
    expect(isBuiltinMcpName("browser")).toBe(false);
  });

  it("finds the one built-in server under whichever reserved name it carries", () => {
    expect(findBuiltinMcp({ jinn: 1, browser: 2 })).toEqual({ name: "jinn", spec: 1 });
    expect(findBuiltinMcp({ acme: 1, browser: 2 })).toEqual({ name: "acme", spec: 1 });
    expect(findBuiltinMcp({ browser: 2 })).toBeUndefined();
    expect(findBuiltinMcp(undefined)).toBeUndefined();
  });
});

describe("resolving the set under a per-instance name", () => {
  // Attachment also needs the authed smoke probe to have passed.
  beforeEach(() => setJinnAttachGate({ ok: true }));
  afterEach(() => setJinnAttachGate(null));

  it("registers one server, under the instance's name, never both", () => {
    expect(Object.keys(resolveMcpServers(GATEWAY_ON, undefined, "claude", "jinn").mcpServers)).toContain("jinn");
    const switched = Object.keys(resolveMcpServers(GATEWAY_ON, undefined, "claude", "acme").mcpServers);
    expect(switched).toContain("acme");
    expect(switched).not.toContain("jinn");
  });

  it("registers it under the instance's name with no mcp section at all, for a force-on pilot", () => {
    expect(Object.keys(resolveMcpServers(undefined, employee({ jinnMcp: true }), "claude", "acme").mcpServers)).toEqual(["acme"]);
  });

  it("honours an allowlist that still names the built-in by the other reserved name", () => {
    for (const listed of ["jinn", "acme"]) {
      const set = resolveMcpServers(GATEWAY_ON, employee({ mcp: [listed] }), "claude", "acme").mcpServers;
      expect(Object.keys(set)).toEqual(["acme"]);
    }
    expect(Object.keys(resolveMcpServers(GATEWAY_ON, employee({ mcp: ["browser"] }), "claude", "acme").mcpServers)).toEqual(["browser"]);
  });

  it("never lets a custom server take either reserved name", () => {
    const custom = { command: "evil" };
    const set = resolveMcpServers({ gateway: { enabled: true }, custom: { jinn: custom, acme: custom, ok: custom } }, undefined, "claude", "acme").mcpServers;
    expect(Object.keys(set).sort()).toEqual(["acme", "browser", "ok"].sort());
    expect((set.acme as { command: string }).command).not.toBe("evil");
  });

  it("stamps the session identity onto the server under its registered name", () => {
    const set = resolveMcpServers(GATEWAY_ON, undefined, "claude", "acme");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-name-"));
    try {
      vi.stubEnv("JINN_HOME", home);
      vi.stubEnv("ACME_HOME", home);
      const stamped = attachSessionIdentity(set, "sess-1");
      const server = stamped.mcpServers.acme as { args: string[]; env: Record<string, string> };
      expect(server.args).toContain("--acme-session-id");
      expect(server.env.JINN_SESSION_ID).toBe("sess-1");
      expect(stamped.mcpServers.jinn).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a scoped department's session on the built-in server under either name", () => {
    for (const name of ["jinn", "acme"]) {
      const resolved: ResolvedMcpConfig = { mcpServers: { [name]: { command: "node" }, browser: { command: "npx" } } };
      expect(Object.keys(confineMcpToDepartment(resolved, "no-such-department").mcpServers)).toEqual([name]);
    }
  });

  it("scopes the board walk's opencode agent to tools named by the registered server", () => {
    expect(Object.keys(boardWalkAgentPermission("acme")).filter((key) => key !== "*").every((key) => key.startsWith("acme_"))).toBe(true);
  });
});

describe("engine config files under a per-instance name", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-engines-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const resolvedAs = (name: string): ResolvedMcpConfig => ({
    mcpServers: { [name]: { command: "/usr/bin/node", args: ["/abs/server-entry.js"], env: { JINN_GATEWAY_URL: "http://127.0.0.1:7799", JINN_SESSION_CAPABILITY: "cap" } } },
  });

  it("grok writes the table under the registered name, and an earlier build's file is managed rather than a user's own", () => {
    fs.mkdirSync(path.join(tmp, ".grok"));
    fs.writeFileSync(path.join(tmp, ".grok", "config.toml"), "# jinn-managed: auto-generated MCP attach config (GRS-012c). Safe to delete.\n[mcp_servers.jinn]\ncommand = \"stale\"\n");
    const handle = prepareGrokProjectMcpConfig(tmp, resolvedAs("acme"));
    expect(handle.attached).toBe(true);
    const written = fs.readFileSync(path.join(tmp, ".grok", "config.toml"), "utf-8");
    expect(written).toContain("[mcp_servers.acme]");
    expect(written).not.toContain("[mcp_servers.jinn]");
    expect(written.startsWith("# acme-managed:")).toBe(true);
    cleanupGrokProjectMcpConfig(handle);
    expect(fs.existsSync(path.join(tmp, ".grok", "config.toml"))).toBe(false);
  });

  it("grok still refuses to overwrite a file that is a user's own", () => {
    fs.mkdirSync(path.join(tmp, ".grok"));
    fs.writeFileSync(path.join(tmp, ".grok", "config.toml"), "# my own config\n");
    expect(prepareGrokProjectMcpConfig(tmp, resolvedAs("acme")).attached).toBe(false);
    expect(fs.readFileSync(path.join(tmp, ".grok", "config.toml"), "utf-8")).toBe("# my own config\n");
  });

  it("antigravity replaces the entry an earlier build wrote under the other name, and leaves a user's own", () => {
    const configPath = path.join(tmp, "mcp_config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        jinn: { command: "stale", env: { JINN_MCP_MANAGED_BY: "jinn-managed-antigravity" } },
        search: { command: "search-cli" },
      },
    }));
    expect(ensureAntigravityJinnMcpConfig(resolvedAs("acme"), { configPath }).attached).toBe(true);
    const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(Object.keys(json.mcpServers).sort()).toEqual(["acme", "search"]);
    expect(json.mcpServers.acme.env.ACME_MCP_MANAGED_BY).toBe("acme-managed-antigravity");
  });

  it("antigravity declines when a user's own entry already holds the registered name", () => {
    const configPath = path.join(tmp, "mcp_config.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { acme: { command: "mine" } } }));
    expect(ensureAntigravityJinnMcpConfig(resolvedAs("acme"), { configPath }).attached).toBe(false);
  });

  it("codex strips the base config's stale stanza under either name and writes its own under the registered one", () => {
    const realHome = path.join(tmp, "real-codex");
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "config.toml"), 'model = "gpt-5.5"\n\n[mcp_servers.jinn]\ncommand = "stale"\n\n[mcp_servers.jinn.env]\nX = "1"\n\n[mcp_servers.acme]\ncommand = "stale"\n');
    vi.stubEnv("CODEX_HOME", realHome);
    try {
      const home = prepareCodexSessionHome(resolvedAs("acme"), "sess-1", { baseDir: path.join(tmp, "homes") })!;
      const cfg = fs.readFileSync(path.join(home.home, "config.toml"), "utf-8");
      expect(cfg).toContain('model = "gpt-5.5"');
      expect(cfg).not.toContain("stale");
      expect(cfg.match(/^\[mcp_servers\.[a-z]+\]/gm)).toEqual(["[mcp_servers.acme]"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
