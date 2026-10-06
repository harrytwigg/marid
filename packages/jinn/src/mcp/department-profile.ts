import type { JinnMcpTool } from "./toolkit.js";

/**
 * FR-019: a department-scoped session's tool manifest omits every tool whose routes
 * the gateway refuses it, so the agent is not offered what it cannot use, and always
 * carries the note tools, which the gateway serves to scoped sessions rooted at their
 * department's folder even when Notes are off (FR-028). The gateway refuses these
 * routes either way; this is the offer, not the enforcement. Unscoped manifests are
 * exactly `buildTools`'s.
 */

export const DEPARTMENT_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  "list_cron_jobs",
  "get_cron_run_history",
  "cost_report",
  "send_connector_message",
  "list_files",
  "read_file",
  "create_label",
  "archive_work_item",
]);

/** The server's tool belt: `build` as configured, or the scoped profile when `JINN_DEPARTMENT` is set. */
export function departmentBelt<T extends { notesEnabled?: boolean }>(
  build: (opts: T) => JinnMcpTool[],
  opts: T,
  env: NodeJS.ProcessEnv = process.env,
): JinnMcpTool[] {
  if (!env.JINN_DEPARTMENT) return build(opts);
  return build({ ...opts, notesEnabled: true }).filter((tool) => !DEPARTMENT_REFUSED_TOOLS.has(tool.name));
}

