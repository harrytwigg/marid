import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { resolveEngineRunMcp, resolveSessionEngineMcp } from "../engine-run-mcp.js";
import type { JinnConfig, McpGlobalConfig } from "../../shared/types.js";

/**
 * The opencode terminal view can start a session's server before any turn has,
 * so it must resolve exactly the MCP set that session's next turn will — or the
 * turn replaces the server, and the view and anything the operator typed with
 * it. `resolveSessionEngineMcp` is that resolution; these pin it to the call
 * `preflightTurn` makes.
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

describe("resolveSessionEngineMcp", () => {
  it("resolves a session with the same MCP set a turn resolves", () => {
    const session = { id: "sess-plain" } as never;
    const viaSession = resolveSessionEngineMcp({ config, session, engine: "opencode" });
    expect(viaSession.resolvedMcp).toEqual(resolveEngineRunMcp({ config, engine: "opencode", sessionId: "sess-plain" }).resolvedMcp);
  });
});
