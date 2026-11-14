// packages/hundredfold/src/mcp/__tests__/remote-config.test.ts
/**
 * Remote (SSH) execution — the MCP set is resolved on the GATEWAY and consumed
 * on ANOTHER MACHINE.
 *
 * Three producers bake the gateway's filesystem into a resolved set:
 * `buildHundredfoldServerSpec` (resolver.ts), `wrapServersWithScrub` (env-scrub.ts) and
 * `attachSessionIdentity` (identity.ts). The input here is built by running that
 * REAL pipeline rather than by hand, so a change to any of their shapes lands in
 * this file instead of silently shipping a config the remote cannot execute.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remapMcpConfigForRemote, type RemoteMcpRemapOpts } from "../remote-config.js";
import { resolveMcpServers } from "../resolver.js";
import { attachSessionIdentity, MCP_GATEWAY_URL_ARG, MCP_HOME_ARG, MCP_SESSION_ID_ARG } from "../identity.js";
import { setHundredfoldAttachGate } from "../attachment.js";
import type { Employee, McpGlobalConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../../shared/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/hundredfold — the gateway checkout the resolved set points into. */
const PKG_ROOT = path.resolve(HERE, "../../..");

/** JSON.stringify escapes Windows separators; compare against the escaped form
 *  so the end-to-end assertion means the same thing on both CI legs. */
const asJsonBody = (value: string): string => JSON.stringify(value).slice(1, -1);

const OPTS: RemoteMcpRemapOpts = {
  remoteNode: "/usr/local/lib/node/bin/node",
  remoteEntryDir: "/srv/agents/.hundredfold-remote/mcp",
  remoteHome: "/srv/agents/.hundredfold-remote/home",
  gatewayUrl: "http://127.0.0.1:45123",
};

const GATEWAY_URL = "http://127.0.0.1:7777";
const SESSION_ID = "sess-remote-1";

const globalMcp: McpGlobalConfig = {
  browser: { enabled: false },
  fetch: { enabled: true },
  custom: {
    docs: { url: "https://mcp.example.invalid/sse" },
  },
};

function buildResolved(): ResolvedMcpConfig {
  const resolved = resolveMcpServers(globalMcp, { name: "remote-employee" } as Employee, "claude");
  return attachSessionIdentity(resolved, SESSION_ID);
}

const stdio = (config: ResolvedMcpConfig, name: string): McpServerStdioConfig =>
  config.mcpServers[name] as McpServerStdioConfig;

describe("remapMcpConfigForRemote (real resolver → identity → scrub pipeline)", () => {
  let previousGatewayUrl: string | undefined;

  beforeEach(() => {
    setHundredfoldAttachGate({ ok: true });
    previousGatewayUrl = process.env.HUNDREDFOLD_GATEWAY_URL;
    process.env.HUNDREDFOLD_GATEWAY_URL = GATEWAY_URL;
  });

  afterEach(() => {
    setHundredfoldAttachGate(null);
    if (previousGatewayUrl === undefined) delete process.env.HUNDREDFOLD_GATEWAY_URL;
    else process.env.HUNDREDFOLD_GATEWAY_URL = previousGatewayUrl;
  });

  it("re-points the builtin hundredfold server at the remote node and the staged entry", () => {
    const input = buildResolved();
    // Premise: the resolver really did bake the gateway's own interpreter and
    // dist path in — otherwise the assertions below prove nothing.
    expect(stdio(input, "hundredfold").command).toBe(process.execPath);
    expect(stdio(input, "hundredfold").args?.[0]).toContain(PKG_ROOT);

    const hundredfold = stdio(remapMcpConfigForRemote(input, OPTS), "hundredfold");
    expect(hundredfold.command).toBe(OPTS.remoteNode);
    expect(hundredfold.args?.[0]).toBe("/srv/agents/.hundredfold-remote/mcp/server-entry.js");
  });

  it("re-points a scrub-wrapped third-party server, keeping its real command and args", () => {
    const input = buildResolved();
    expect(stdio(input, "fetch").command).toBe(process.execPath);
    expect(stdio(input, "fetch").args?.[0]).toContain(PKG_ROOT);

    const fetchServer = stdio(remapMcpConfigForRemote(input, OPTS), "fetch");
    expect(fetchServer.command).toBe(OPTS.remoteNode);
    expect(fetchServer.args?.[0]).toBe("/srv/agents/.hundredfold-remote/mcp/scrub-entry.js");
    // The wrapped-in command the launcher execs is the remote's business, not ours.
    expect(fetchServer.args?.slice(1)).toEqual(["uvx", "mcp-server-fetch"]);
  });

  it("leaves NO gateway path anywhere in the serialized config", () => {
    const input = buildResolved();
    const before = JSON.stringify(input);
    expect(before).toContain(asJsonBody(PKG_ROOT));
    expect(before).toContain(asJsonBody(process.execPath));

    const after = JSON.stringify(remapMcpConfigForRemote(input, OPTS));
    expect(after).not.toContain(asJsonBody(PKG_ROOT));
    expect(after).not.toContain(asJsonBody(process.execPath));
  });

  it("rewrites the bootstrap flag VALUES and the matching env, and nothing else", () => {
    const input = buildResolved();
    const inputHundredfold = stdio(input, "hundredfold");
    expect(inputHundredfold.args).toContain(MCP_HOME_ARG);
    expect(inputHundredfold.args).toContain(MCP_GATEWAY_URL_ARG);

    const hundredfold = stdio(remapMcpConfigForRemote(input, OPTS), "hundredfold");
    const args = hundredfold.args ?? [];
    expect(args[args.indexOf(MCP_HOME_ARG) + 1]).toBe(OPTS.remoteHome);
    expect(args[args.indexOf(MCP_GATEWAY_URL_ARG) + 1]).toBe(OPTS.gatewayUrl);
    expect(hundredfold.env?.HUNDREDFOLD_HOME).toBe(OPTS.remoteHome);
    expect(hundredfold.env?.HUNDREDFOLD_GATEWAY_URL).toBe(OPTS.gatewayUrl);

    // The session id and its bound capability are minted on the gateway and
    // verified there — a rewrite would make the remote server unauthorized.
    expect(args[args.indexOf(MCP_SESSION_ID_ARG) + 1]).toBe(SESSION_ID);
    expect(hundredfold.env?.HUNDREDFOLD_SESSION_ID).toBe(SESSION_ID);
    expect(hundredfold.env?.HUNDREDFOLD_SESSION_CAPABILITY).toBe(inputHundredfold.env?.HUNDREDFOLD_SESSION_CAPABILITY);
  });

  it("passes URL-transport servers through and never mutates the input", () => {
    const input = buildResolved();
    const snapshot = structuredClone(input);

    const out = remapMcpConfigForRemote(input, OPTS);

    expect(out.mcpServers.docs).toBe(input.mcpServers.docs);
    expect(out.mcpServers.docs).toEqual({ type: "sse", url: "https://mcp.example.invalid/sse" });
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });
});

describe("remapMcpConfigForRemote (argument boundaries)", () => {
  it("fixes env HUNDREDFOLD_GATEWAY_URL even when the flag is absent", () => {
    const input: ResolvedMcpConfig = {
      mcpServers: { hundredfold: { command: process.execPath, args: ["/gw/dist/mcp/server-entry.js"], env: { HUNDREDFOLD_GATEWAY_URL: GATEWAY_URL, HUNDREDFOLD_HOME: "/gw/home" } } },
    };
    const hundredfold = stdio(remapMcpConfigForRemote(input, OPTS), "hundredfold");
    expect(hundredfold.args).toEqual(["/srv/agents/.hundredfold-remote/mcp/server-entry.js"]);
    expect(hundredfold.env).toEqual({ HUNDREDFOLD_GATEWAY_URL: OPTS.gatewayUrl, HUNDREDFOLD_HOME: OPTS.remoteHome });
  });

  it("leaves a trailing valueless flag and a non-absolute entry name alone", () => {
    const input: ResolvedMcpConfig = {
      mcpServers: { odd: { command: "npx", args: ["server-entry.js", MCP_HOME_ARG] } },
    };
    expect(stdio(remapMcpConfigForRemote(input, OPTS), "odd").args).toEqual(["server-entry.js", MCP_HOME_ARG]);
  });

  it("adds no instance env to a server that carries none", () => {
    const input: ResolvedMcpConfig = { mcpServers: { plain: { command: "npx", args: ["-y", "some-mcp"] } } };
    const plain = stdio(remapMcpConfigForRemote(input, OPTS), "plain");
    expect(plain).toEqual({ command: "npx", args: ["-y", "some-mcp"] });
    expect(plain.env).toBeUndefined();
  });
});
