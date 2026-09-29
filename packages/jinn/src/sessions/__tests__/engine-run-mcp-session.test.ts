import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { JINN_WORKFLOW_ATTEMPT_ENV } from "../../mcp/identity.js";
import { resolveEngineRunMcp, resolveSessionEngineMcp } from "../engine-run-mcp.js";
import type { JinnConfig, McpGlobalConfig, McpServerStdioConfig } from "../../shared/types.js";

/**
 * The opencode terminal view can start a session's server before any turn has,
 * so it must resolve exactly the MCP set that session's next turn will — or the
 * turn replaces the server, and the view and anything the operator typed with
 * it. `resolveSessionEngineMcp` is that resolution; these pin it to the call
 * `preflightTurn` makes, Workflow-attempt rule included.
 */

const config = { mcp: { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig } as unknown as JinnConfig;
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = { JINN_GATEWAY_URL: process.env.JINN_GATEWAY_URL, JINN_GATEWAY_TOKEN: process.env.JINN_GATEWAY_TOKEN };
  process.env.JINN_GATEWAY_URL = "http://127.0.0.1:56789";
  process.env.JINN_GATEWAY_TOKEN = "session-mcp-test-token";
  setJinnAttachGate({ ok: true });
});

afterEach(() => {
  setJinnAttachGate(null);
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const jinnEnv = (mcp: ReturnType<typeof resolveSessionEngineMcp>) =>
  (mcp.resolvedMcp?.mcpServers.jinn as McpServerStdioConfig | undefined)?.env ?? {};

describe("resolveSessionEngineMcp", () => {
  it("resolves a Workflow-phase session with the Workflow-attempt identity, as preflight does", () => {
    const session = { id: "sess-wf", workflowProvenance: { kind: "phase" } } as never;
    const viaSession = resolveSessionEngineMcp({ config, session, engine: "opencode" });
    const asPreflight = resolveEngineRunMcp({ config, engine: "opencode", sessionId: "sess-wf", workflowAttempt: true });
    expect(jinnEnv(viaSession)[JINN_WORKFLOW_ATTEMPT_ENV]).toBe("1");
    expect(viaSession.resolvedMcp).toEqual(asPreflight.resolvedMcp);
  });

  it("resolves any other session without it", () => {
    const session = { id: "sess-plain", workflowProvenance: null } as never;
    const viaSession = resolveSessionEngineMcp({ config, session, engine: "opencode" });
    expect(jinnEnv(viaSession)[JINN_WORKFLOW_ATTEMPT_ENV]).toBeUndefined();
    expect(viaSession.resolvedMcp).toEqual(resolveEngineRunMcp({ config, engine: "opencode", sessionId: "sess-plain" }).resolvedMcp);
  });
});
