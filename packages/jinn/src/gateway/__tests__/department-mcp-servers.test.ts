import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { createSession } from "../../sessions/registry.js";
import { resolveEngineRunMcp } from "../../sessions/engine-run-mcp.js";
import type { Employee, JinnConfig, McpGlobalConfig } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { departmentRecord, refreshDepartments } from "../department-registry.js";
import { readDepartmentPatch, writeDepartmentFile as patchDepartmentFile } from "../department-store.js";
import { refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * A department-scoped session gets the built-in `jinn` server and only the instance MCP
 * servers its `department.yaml` allow-lists under `mcp`. No other server's spec, and so
 * none of the credentials it carries, reaches the session's MCP config file.
 */

const SECRET = "instance-server-secret-value";
const config = {
  mcp: {
    browser: { enabled: true },
    gateway: { enabled: true },
    custom: {
      alpha: { command: "npx", args: ["alpha-mcp"], env: { ALPHA_API_KEY: SECRET } },
      beta: { url: "https://beta.invalid/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
    },
  } as unknown as McpGlobalConfig,
} as unknown as JinnConfig;

const employee = (name: string, department: string) => ({ name, department, engine: "claude" }) as Employee;

function loadOrg(extra = ""): void {
  writeDepartmentFile("side-project", `name: side-project\nscope: scoped\n${extra}`);
  writeEmployeeFile("engineering", "eng-dev");
  writeEmployeeFile("side-project", "side-dev");
  refreshOrg();
}

function run(name: string, department: string, sessionId: string, engine = "claude") {
  return resolveEngineRunMcp({ config, employee: employee(name, department), engine, sessionId });
}

const serverNames = (result: ReturnType<typeof run>) => Object.keys(result.resolvedMcp?.mcpServers ?? {}).sort();

beforeEach(() => {
  resetDepartmentFixtures();
  setJinnAttachGate({ ok: true });
});

afterEach(() => {
  setJinnAttachGate(null);
  vi.restoreAllMocks();
});

describe("the mcp allow-list in department.yaml", () => {
  it("is read for a scoped department, keeping each server name once, whatever characters a custom key uses", () => {
    loadOrg("mcp: [alpha, github/copilot, _internal, alpha, 3]\n");
    const record = departmentRecord("side-project");
    expect(record.definition?.mcp).toEqual(["alpha", "github/copilot", "_internal"]);
    expect(record.warnings).toContain("mcp: ignored a non-text entry");
  });

  it("is written by a department PATCH and read back", () => {
    loadOrg();
    patchDepartmentFile("side-project", readDepartmentPatch({ mcp: [" alpha ", "beta"] }));
    refreshDepartments();
    expect(departmentRecord("side-project").definition?.mcp).toEqual(["alpha", "beta"]);
    expect(() => readDepartmentPatch({ mcp: "alpha" })).toThrow(/mcp must be a list of text/);
  });

  it("is empty when absent", () => {
    loadOrg();
    expect(departmentRecord("side-project").definition?.mcp).toEqual([]);
  });
});

describe("a department-scoped session's MCP servers", () => {
  it("are the jinn server alone when its department allow-lists none, and the written config holds no other server's credentials", () => {
    loadOrg();
    const session = createSession({ engine: "claude", source: "web", sourceRef: "web:scoped", employee: "side-dev" });
    const result = run("side-dev", "side-project", session.id);
    expect(serverNames(result)).toEqual(["jinn"]);
    const written = fs.readFileSync(result.mcpConfigPath!, "utf-8");
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("playwright");
  });

  it("add the servers its department allow-lists, and only those", () => {
    loadOrg("mcp: [alpha, not-configured]\n");
    const session = createSession({ engine: "claude", source: "web", sourceRef: "web:allow", employee: "side-dev" });
    const result = run("side-dev", "side-project", session.id);
    expect(serverNames(result)).toEqual(["alpha", "jinn"]);
    expect(fs.readFileSync(result.mcpConfigPath!, "utf-8")).not.toContain("beta.invalid");
  });

  it("are confined for every MCP-capable engine, not just claude", () => {
    loadOrg();
    const session = createSession({ engine: "opencode", source: "web", sourceRef: "web:opencode", employee: "side-dev" });
    expect(serverNames(run("side-dev", "side-project", session.id, "opencode"))).toEqual(["jinn"]);
  });

  it("are confined by the employee's scope when the session carries no binding", () => {
    loadOrg();
    expect(serverNames(run("side-dev", "side-project", "no-such-session"))).toEqual(["jinn"]);
  });

  it("name a server the employee's own mcp list asks for that the department does not allow", () => {
    loadOrg();
    const warn = vi.spyOn(logger, "warn");
    const session = createSession({ engine: "claude", source: "web", sourceRef: "web:own", employee: "side-dev" });
    const result = resolveEngineRunMcp({ config, employee: { ...employee("side-dev", "side-project"), mcp: ["jinn", "beta"] }, engine: "claude", sessionId: session.id });
    expect(serverNames(result)).toEqual(["jinn"]);
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toMatch(/side-dev requests MCP server "beta" but department "side-project" does not allow it/);
  });

  it("leave an unscoped session with every instance server", () => {
    loadOrg();
    const session = createSession({ engine: "claude", source: "web", sourceRef: "web:open", employee: "eng-dev" });
    expect(serverNames(run("eng-dev", "engineering", session.id))).toEqual(["alpha", "beta", "browser", "jinn"]);
  });
});
