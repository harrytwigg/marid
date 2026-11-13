import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Employee, JinnConfig } from "../../shared/types.js";

let home: string;

vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  resolveJinnHome: () => home,
}));

import { setJinnAttachGate } from "../../mcp/attachment.js";
import { scanOrg } from "../../gateway/org.js";
import { resolveEngineRunMcp, resolveSessionEngineMcp } from "../engine-run-mcp.js";
import { resolveMcpServers } from "../../mcp/resolver.js";

/**
 * A built-in system employee (the Todo Dispatcher, the Todo Shaper) is staged
 * exactly `jinn` and `browser`, like any employee that lists those two. It must
 * not receive the instance's custom servers, on any engine and on any path that
 * resolves a session's MCP set: a turn, the terminal view, a fallback hop.
 */

const config = {
  engines: { default: "opencode", claude: { bin: "claude", model: "sonnet" }, opencode: { bin: "opencode" } },
  mcp: {
    custom: {
      crm: { command: "crm-mcp" },
      tickets: { url: "https://tickets.example.test/mcp" },
    },
  },
} as unknown as JinnConfig;

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-system-mcp-"));
  envBackup = { JINN_GATEWAY_URL: process.env.JINN_GATEWAY_URL, JINN_GATEWAY_TOKEN: process.env.JINN_GATEWAY_TOKEN };
  process.env.JINN_GATEWAY_URL = "http://127.0.0.1:56789";
  process.env.JINN_GATEWAY_TOKEN = "system-mcp-test-token";
  setJinnAttachGate({ ok: true });
});

afterEach(() => {
  setJinnAttachGate(null);
  fs.rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function systemEmployee(name: string): Employee {
  const employee = scanOrg(config).get(name);
  if (!employee?.system) throw new Error(`${name} is not a built-in system employee`);
  return employee;
}

const names = (mcp: { mcpServers: Record<string, unknown> } | undefined) => Object.keys(mcp?.mcpServers ?? {}).sort();

describe.each(["todo-dispatcher", "todo-shaper"])("MCP set of the system employee %s", (name) => {
  it("is jinn and browser on a turn, never a custom server, on opencode", () => {
    const run = resolveEngineRunMcp({ config, employee: systemEmployee(name), engine: "opencode", sessionId: "sys-turn" });
    expect(names(run.resolvedMcp)).toEqual(["browser", "jinn"]);
  });

  it("is the same on the terminal view and a fallback hop", () => {
    const employee = systemEmployee(name);
    const view = resolveSessionEngineMcp({ config, session: { id: "sys-view" }, employee, engine: "opencode" });
    const hop = resolveEngineRunMcp({ config, employee, engine: "codex", sessionId: "sys-hop" });
    expect(names(view.resolvedMcp)).toEqual(["browser", "jinn"]);
    expect(names(hop.resolvedMcp)).toEqual(["browser", "jinn"]);
  });

  it("is the same on claude", () => {
    const run = resolveEngineRunMcp({ config, employee: systemEmployee(name), engine: "claude", sessionId: "sys-claude" });
    expect(names(run.resolvedMcp)).toEqual(["browser", "jinn"]);
  });
});

describe("other employees' MCP set", () => {
  it("is unchanged: an employee with no mcp: list still gets every enabled server", () => {
    const employee = { name: "plain", displayName: "Plain", department: "ops", rank: "employee", engine: "opencode", persona: "p" } as Employee;
    expect(names(resolveMcpServers(config.mcp, employee, "opencode"))).toEqual(["browser", "crm", "jinn", "tickets"]);
  });

  it("is unchanged: an explicit mcp: list picks exactly its servers", () => {
    const employee = { name: "picky", displayName: "Picky", department: "ops", rank: "employee", engine: "opencode", persona: "p", mcp: ["jinn", "crm"] } as Employee;
    expect(names(resolveMcpServers(config.mcp, employee, "opencode"))).toEqual(["crm", "jinn"]);
  });
});
