import { getSession } from "../../sessions/registry.js";
import { DEPARTMENT_FILE_ROOTS_ENV } from "../../shared/department-file-roots.js";
import { departmentFileRoots } from "./paths.js";

/** The session marker every process of a department-scoped session carries (FR-028). */
export const JINN_DEPARTMENT_ENV = "JINN_DEPARTMENT";

/** `JINN_DEPARTMENT` for a session bound to a department; nothing for any other session. */
export function departmentSessionEnv(sessionId: string | undefined): Record<string, string> {
  const department = sessionId ? getSession(sessionId)?.scopeDepartment : null;
  return department ? { [JINN_DEPARTMENT_ENV]: department } : {};
}

/**
 * The jinn MCP server's share: the marker, which selects the scoped tool profile
 * (`mcp/department-profile.ts`), and the roots the two file-reading tools hold paths
 * to (FR-018), read at spawn so the server needs no gateway round trip to decide.
 */
export function departmentMcpEnv(sessionId: string): Record<string, string> {
  const marker = departmentSessionEnv(sessionId);
  const department = marker[JINN_DEPARTMENT_ENV];
  return department ? { ...marker, [DEPARTMENT_FILE_ROOTS_ENV]: JSON.stringify(departmentFileRoots(department)) } : {};
}
