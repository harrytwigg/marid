import { context, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeEmployeeFile } from "./department-fixtures.js";
import { refreshOrg } from "../org-registry.js";
import { departmentMcpEnv } from "../department-scope/session-env.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import {
  attachSessionIdentity,
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  ensureSessionCapability,
  TOOL_CALL_HEADER,
} from "../../mcp/identity.js";
import { remapMcpConfigForRemote } from "../../mcp/remote-config.js";
import { resolveMcpServers } from "../../mcp/resolver.js";
import { resolveMcpSessionCapabilityKeyFile } from "../../shared/home.js";
import { logger } from "../../shared/logger.js";
import type { McpGlobalConfig, McpServerStdioConfig } from "../../shared/types.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * A department-scoped session on a remote host, end to end: the gateway stamps its jinn
 * server, the stager re-points that spec at the host's install and at the session's
 * stage home, the REAL server entry is launched from it exactly as the engine would, and
 * its tool calls cross a real socket into the real `handleApiRequest`.
 *
 * A scoped stage home is built with no farm: nothing in it leads back to the gateway's
 * home, the capability key included. The server used to derive its capability from that
 * home's key, minting one when there was none, so every call carried a capability the
 * gateway could not verify and was refused as `unidentified-tool`.
 *
 * The server is the built one (`dist`), as the other spawn tests use; `pnpm test` builds first.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_ENTRY_DIR = path.resolve(HERE, "../../../dist/src/mcp");
const REMOTE = { root: "/srv/root", mount: "/mnt/jinn" };
const TOKEN = "scoped-remote-mcp-gateway-token-0123456789";
const ON = { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig;

/** Every request the gateway received, with the identity headers as it saw them. */
const received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; status: number }> = [];
let gateway: http.Server;
let gatewayUrl: string;
let stageHome: string;
let scopedId: string;
let peerId: string;
let inside: WorkItem;
let outside: WorkItem;

beforeAll(async () => {
  const { workItems } = await startScopedHarness();
  const base = context.getConfig;
  (context as { getConfig: typeof base }).getConfig = () => ({ ...base(), remote: REMOTE });
  (context as { gatewayAuthToken: string }).gatewayAuthToken = TOKEN;
  writeEmployeeFile("side-project", "side-remote", { department: "side-project", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg(context.getConfig());
  inside = workItems.createWorkItem({ title: "inside the department", department: "side-project", assignee: "side-dev" });
  outside = workItems.createWorkItem({ title: "outside the department", department: "engineering", assignee: "eng-dev" });
  const scoped = await sessionOf("side-remote");
  if (scoped.scopeDepartment !== "side-project") throw new Error("the remote employee's session is not bound to its scoped department");
  scopedId = scoped.id;
  peerId = (await sessionOf("side-dev")).id;

  const { handleApiRequest } = await import("../api.js");
  gateway = http.createServer((req, res) => {
    res.on("finish", () => received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, status: res.statusCode }));
    void handleApiRequest(req, res, context);
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  // The stage home a scoped remote session gets: the bearer it is handed, and nothing else.
  stageHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-scoped-remote-stage-"));
  fs.writeFileSync(path.join(stageHome, "gateway.json"), `${JSON.stringify({ token: TOKEN })}\n`, { mode: 0o600 });
});

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  fs.rmSync(stageHome, { recursive: true, force: true });
});

/** The jinn server spec the stager writes into the scoped session's `tmp/mcp.json`. */
function stagedJinnServer(): McpServerStdioConfig {
  // A booted gateway arms the attach gate and exports its own URL, which the stager re-points at the tunnel.
  setJinnAttachGate({ ok: true });
  const ownUrl = process.env.JINN_GATEWAY_URL;
  process.env.JINN_GATEWAY_URL = "http://127.0.0.1:7799";
  try {
    const stamped = attachSessionIdentity(resolveMcpServers(ON, undefined), scopedId, departmentMcpEnv(scopedId));
    const remapped = remapMcpConfigForRemote(stamped, {
      remoteNode: process.execPath,
      remoteEntryDir: REMOTE_ENTRY_DIR,
      remoteHome: stageHome,
      gatewayUrl,
      departmentFileRoots: ["/srv/root/work", "/srv/root/.jinn-departments/side-project"],
    });
    return remapped.mcpServers.jinn as McpServerStdioConfig;
  } finally {
    setJinnAttachGate(null);
    if (ownUrl === undefined) delete process.env.JINN_GATEWAY_URL;
    else process.env.JINN_GATEWAY_URL = ownUrl;
  }
}

/** Launch the staged server as the engine does and make one tool call over stdio. */
async function callTool(spec: McpServerStdioConfig, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args ?? [], {
    env: { PATH: process.env.PATH ?? "", ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${name}; server stderr: ${stderr}`)), 20_000);
      let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += String(chunk);
        for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
          const message = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (message.id !== 2) continue;
          clearTimeout(timer);
          resolve({ text: message.result.content[0].text, isError: message.result.isError === true });
        }
      });
      child.on("exit", (code) => reject(new Error(`server exited (${code}) before answering ${name}; stderr: ${stderr}`)));
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    });
  } finally {
    child.kill();
  }
}

function lastRequest(pathPrefix: string) {
  const match = received.filter((request) => request.url.startsWith(pathPrefix)).at(-1);
  if (!match) throw new Error(`the gateway received no request for ${pathPrefix}`);
  return match;
}

describe("a department-scoped session on a remote host, through its staged jinn MCP server", () => {
  it("is staged with the gateway's capability for the session, and a home holding no key", () => {
    const spec = stagedJinnServer();
    expect(spec.env?.JINN_HOME).toBe(stageHome);
    expect(spec.env?.JINN_DEPARTMENT).toBe("side-project");
    expect(spec.env?.JINN_SESSION_CAPABILITY).toBe(ensureSessionCapability(scopedId));
    expect(spec.env?.JINN_GATEWAY_URL).toBe(gatewayUrl);
    expect(spec.args).toEqual(expect.arrayContaining([stageHome, gatewayUrl]));
    expect(fs.existsSync(resolveMcpSessionCapabilityKeyFile(stageHome))).toBe(false);
  });

  it("list_employees reaches the gateway with the session's identity and answers with the department only", async () => {
    const result = await callTool(stagedJinnServer(), "list_employees");
    expect(result.isError, result.text).toBe(false);

    const request = lastRequest("/api/org");
    expect(request.status).toBe(200);
    expect(request.headers[TOOL_CALL_HEADER]).toBe("jinn-mcp");
    expect(request.headers[CALLER_SESSION_HEADER]).toBe(scopedId);
    expect(request.headers[CALLER_SESSION_CAPABILITY_HEADER]).toBe(ensureSessionCapability(scopedId));
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(result.text).toContain("side-dev");
    expect(result.text).toContain("side-remote");
    for (const stranger of ["eng-dev", "other-dev", "route-worker"]) expect(result.text).not.toContain(stranger);
  });

  it("list_work_items answers with the department's Todos only", async () => {
    const result = await callTool(stagedJinnServer(), "list_work_items");
    expect(result.isError, result.text).toBe(false);
    expect(lastRequest("/api/work-items").status).toBe(200);
    expect(result.text).toContain(inside.id);
    expect(result.text).not.toContain(outside.id);
  });

  it("send_to_session reaches a session in the department", async () => {
    const result = await callTool(stagedJinnServer(), "send_to_session", { sessionId: peerId, message: "hello from the build box" });
    expect(result.isError, result.text).toBe(false);
    const request = lastRequest(`/api/sessions/${peerId}`);
    expect(request.method).toBe("POST");
    expect(request.status).toBeLessThan(300);
    expect(request.headers[CALLER_SESSION_HEADER]).toBe(scopedId);
  });

  it("never mints a capability key in the stage home", () => {
    expect(fs.existsSync(resolveMcpSessionCapabilityKeyFile(stageHome))).toBe(false);
  });

  it("a stray key already in the stage home (one an older server minted) does not override the stamped capability", async () => {
    const strayKeyFile = resolveMcpSessionCapabilityKeyFile(stageHome);
    ensureSessionCapability(scopedId, strayKeyFile);
    try {
      const result = await callTool(stagedJinnServer(), "list_employees");
      expect(result.isError, result.text).toBe(false);
      expect(lastRequest("/api/org").headers[CALLER_SESSION_CAPABILITY_HEADER]).toBe(ensureSessionCapability(scopedId));
    } finally {
      fs.rmSync(path.dirname(strayKeyFile), { recursive: true, force: true });
    }
  });

  it("a capability that does not verify is refused, and the gateway logs why", async () => {
    const spec = stagedJinnServer();
    const forged = { ...spec, env: { ...spec.env, JINN_SESSION_CAPABILITY: ensureSessionCapability("some-other-session") } };
    const warn = vi.spyOn(logger, "warn");
    try {
      const result = await callTool(forged, "list_work_items");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("caller identity unavailable");
      expect(lastRequest("/api/work-items").status).toBe(403);
      expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringMatching(
        new RegExp(`^Refused identified tool call GET /api/work-items.* from session "${scopedId}": the session capability does not verify`),
      ));
    } finally {
      warn.mockRestore();
    }
  });
});
