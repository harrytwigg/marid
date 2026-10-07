import type { ResolvedMcpConfig } from "../../shared/types.js";
import { departmentRecord } from "../department-registry.js";

/**
 * The MCP set a department-scoped session may carry: the built-in `jinn` server, which
 * the scoped tool profile already confines, and the instance servers its
 * `department.yaml` allow-lists under `mcp`. Every other server is dropped with its
 * spec, so its credentials (an API key in its env, a bearer in its args) are never
 * written to a file the session can read, locally or on a remote host.
 *
 * A department with no definition (its file refused, say) allow-lists nothing, so a
 * scoped session falls back to `jinn` alone rather than to everything. An unscoped
 * session (`department` null) is returned unchanged.
 */
export function confineMcpToDepartment(config: ResolvedMcpConfig, department: string | null | undefined): ResolvedMcpConfig;
export function confineMcpToDepartment(config: ResolvedMcpConfig | undefined, department: string | null | undefined): ResolvedMcpConfig | undefined;
export function confineMcpToDepartment(config: ResolvedMcpConfig | undefined, department: string | null | undefined): ResolvedMcpConfig | undefined {
  if (!config || !department) return config;
  const allowed = new Set(["jinn", ...(departmentRecord(department).definition?.mcp ?? [])]);
  const mcpServers = Object.fromEntries(Object.entries(config.mcpServers).filter(([name]) => allowed.has(name)));
  return { ...config, mcpServers };
}
