import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import type { Employee, JinnConfig } from "../../shared/types.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { resolveEngineRunMcp } from "../engine-run-mcp.js";

/** What the engine run is handed: the built-in server under the name the instance records, whichever path
 *  chose it (the belt, or a purpose-built toolset). */
const employee = (over: Partial<Employee> = {}): Employee => ({ name: "e", displayName: "E", department: "d", rank: "employee", engine: "claude", model: "sonnet", persona: "p", ...over });
const config = (instanceBlock: object): JinnConfig => ({ mcp: { gateway: { enabled: true } }, engines: { default: "claude" }, gateway: { port: 1 }, ...instanceBlock }) as unknown as JinnConfig;
const serversOf = (mcp: ReturnType<typeof resolveEngineRunMcp>): string[] => Object.keys(mcp.resolvedMcp?.mcpServers ?? {}).filter((name) => name !== "browser");

beforeEach(() => setJinnAttachGate({ ok: true }));
afterEach(() => setJinnAttachGate(null));

describe("resolveEngineRunMcp under a per-instance server name", () => {
  it("registers the belt under the legacy name until the instance records its own", () => {
    expect(serversOf(resolveEngineRunMcp({ config: config({}), employee: employee(), engine: "codex", sessionId: "s1" }))).toEqual(["jinn"]);
  });

  it("registers the belt under the name the instance's block records", () => {
    const run = resolveEngineRunMcp({ config: config({ acme: { mcpServerName: "acme" } }), employee: employee(), engine: "codex", sessionId: "s1" });
    expect(serversOf(run)).toEqual(["acme"]);
  });

  it("registers a purpose-built toolset under the same name, as the session's only server", () => {
    const toolset = employee({ toolset: "board-walk" as never });
    expect(Object.keys(resolveEngineRunMcp({ config: config({ jinn: { mcpServerName: "acme" } }), employee: toolset, engine: "codex", sessionId: "s1" }).resolvedMcp!.mcpServers)).toEqual(["acme"]);
    expect(Object.keys(resolveEngineRunMcp({ config: config({}), employee: toolset, engine: "codex", sessionId: "s1" }).resolvedMcp!.mcpServers)).toEqual(["jinn"]);
  });
});
