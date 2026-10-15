import { describe, expect, it } from "vitest";
import type { ResolvedMcpConfig } from "../../shared/types.js";
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
