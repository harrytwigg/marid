import fs from "node:fs";
import path from "node:path";

/**
 * FR-018: a department-scoped session may hand the gateway a local file only from
 * inside its department's working directories or its stage directory. Shared by the
 * gateway's JSON `{path}` attachment route and the two MCP tools that read a path
 * themselves, so the rule is one function wherever it runs.
 *
 * Both sides are compared by realpath, so a symlink inside a root that points out of
 * it is refused, and a root that does not exist yet admits nothing.
 */

/** The environment variable a scoped session's jinn MCP server reads its roots from. */
export const DEPARTMENT_FILE_ROOTS_ENV = "JINN_DEPARTMENT_FILE_ROOTS";

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Whether `file` resolves to a path inside one of `roots`. */
export function insideDepartmentRoots(file: string, roots: readonly string[]): boolean {
  if (!path.isAbsolute(file)) return false;
  const target = realOrNull(file);
  if (!target) return false;
  return roots.some((root) => {
    const real = realOrNull(root);
    return real !== null && (target === real || target.startsWith(real.endsWith(path.sep) ? real : real + path.sep));
  });
}

/** The roots an MCP server was started with; null when the session is not scoped. */
export function departmentRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env[DEPARTMENT_FILE_ROOTS_ENV];
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // Unreadable roots admit nothing: a scoped server fails closed.
    return [];
  }
}

/** The refusal both MCP tools give, naming the roots so the agent can move the file. */
export function departmentPathRefusal(file: string, roots: readonly string[]): string {
  const where = roots.length > 0 ? roots.join(", ") : "none are configured";
  return `${file} is outside this department's working directories and stage directory (${where}); a department-scoped session can only attach files from there`;
}

/** For an MCP tool about to read `file`: the refusal when this server is a scoped session's and the file is outside its roots, else null. */
export function departmentPathError(file: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const roots = departmentRootsFromEnv(env);
  if (!roots) return null;
  return insideDepartmentRoots(file, roots) ? null : departmentPathRefusal(file, roots);
}
