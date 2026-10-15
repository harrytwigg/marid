import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpGlobalConfig, ResolvedMcpConfig } from "../../shared/types.js";
import { resolveMcpServers } from "../../mcp/resolver.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { attachSessionIdentity } from "../../mcp/identity.js";
import { buildMuseSessionConfig, projectMuseMcpServer } from "../musecode-mcp.js";

describe("projectMuseMcpServer", () => {
  it("projects a stdio server with its args and env", () => {
    expect(projectMuseMcpServer("docs", { command: "node", args: ["a.js"], env: { K: "v" } })).toEqual({
      transport: "stdio", command: "node", args: ["a.js"], env: { K: "v" },
    });
  });

  it("leaves out empty args and env", () => {
    expect(projectMuseMcpServer("docs", { command: "node", args: [], env: {} })).toEqual({ transport: "stdio", command: "node" });
  });

  it("projects a URL server as streamableHttp with its headers", () => {
    expect(projectMuseMcpServer("docs", { url: "https://x.test/mcp", headers: { Authorization: "Bearer t" } })).toEqual({
      transport: "streamableHttp", url: "https://x.test/mcp", headers: { Authorization: "Bearer t" },
    });
    expect(projectMuseMcpServer("docs", { type: "sse", url: "https://x.test/sse" })).toEqual({ transport: "streamableHttp", url: "https://x.test/sse" });
  });

  it("makes only the jinn server optional, in either transport", () => {
    expect(projectMuseMcpServer("jinn", { command: "node" })).toMatchObject({ mode: "optional" });
    expect(projectMuseMcpServer("jinn", { url: "https://x.test" })).toMatchObject({ mode: "optional" });
    expect(projectMuseMcpServer("jinn-other", { command: "node" })).not.toHaveProperty("mode");
    expect(projectMuseMcpServer("docs", { command: "node" })).not.toHaveProperty("mode");
  });

  it("is null for a spec Muse cannot run", () => {
    for (const spec of [null, undefined, "node", 7, [], {}, { command: "" }, { url: "" }]) {
      expect(projectMuseMcpServer("x", spec)).toBeNull();
    }
  });

  it("copies the spec rather than sharing its objects", () => {
    const env = { K: "v" };
    const projected = projectMuseMcpServer("x", { command: "node", env }) as { env: Record<string, string> };
    projected.env.K = "changed";
    expect(env.K).toBe("v");
  });
});

describe("buildMuseSessionConfig", () => {
  it("keeps the servers it can project and drops the rest", () => {
    const resolved = { mcpServers: { jinn: { command: "node" }, docs: { url: "https://x.test" }, broken: {} } } as unknown as ResolvedMcpConfig;
    expect(Object.keys(buildMuseSessionConfig(resolved)!.mcpServers)).toEqual(["jinn", "docs"]);
  });

  it("is undefined when there is nothing to send", () => {
    expect(buildMuseSessionConfig(undefined)).toBeUndefined();
    expect(buildMuseSessionConfig({ mcpServers: {} })).toBeUndefined();
    expect(buildMuseSessionConfig({ mcpServers: { broken: {} } } as unknown as ResolvedMcpConfig)).toBeUndefined();
  });
});

/** The jinn server a real resolver payload hands this adapter (the engine-wiring seam for musecode). */
describe("the company toolset, resolved for real", () => {
  const GATEWAY_URL = "http://127.0.0.1:56789";
  const TOKEN = "wiring-test-secret-token";
  const SID = "sess-wiring-0123";
  const ON = { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig;
  const saved = { url: process.env.JINN_GATEWAY_URL, token: process.env.JINN_GATEWAY_TOKEN };

  beforeEach(() => {
    process.env.JINN_GATEWAY_URL = GATEWAY_URL;
    process.env.JINN_GATEWAY_TOKEN = TOKEN;
    setJinnAttachGate({ ok: true });
  });
  afterEach(() => {
    setJinnAttachGate(null);
    for (const [key, value] of [["JINN_GATEWAY_URL", saved.url], ["JINN_GATEWAY_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reaches the session config as an optional stdio server carrying the session's identity, and never the token", () => {
    const resolved = attachSessionIdentity(resolveMcpServers(ON, undefined), SID);
    const jinn = buildMuseSessionConfig(resolved)?.mcpServers.jinn as { transport: string; mode?: string; env?: Record<string, string> };
    expect(jinn).toMatchObject({ transport: "stdio", mode: "optional", env: { JINN_SESSION_ID: SID, JINN_GATEWAY_URL: GATEWAY_URL } });
    expect(jinn.env?.JINN_SESSION_CAPABILITY).toBeTruthy();
    expect(JSON.stringify(jinn)).not.toContain(TOKEN);
  });

  it("is absent when the kill switch is on", () => {
    expect(buildMuseSessionConfig(resolveMcpServers({ browser: { enabled: false }, gateway: { enabled: false } } as McpGlobalConfig, undefined))).toBeUndefined();
  });
});
