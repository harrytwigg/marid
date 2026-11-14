/**
 * The names an opencode process asks its MCP children not to inherit.
 *
 * opencode hands its whole environment to every MCP server it launches, and the gateway holds each opencode account's key
 * in that process's environment (opencode reads it as `{env:<keyEnv>}`). The gateway therefore sets {@link SCRUB_LIST_ENV}
 * on every opencode process it starts, naming every declared key variable, and the two launchers a staged MCP server goes
 * through (`scrub-entry.js` for a third-party server, `server-entry.js` for the built-in one) delete those names, and the
 * list itself, before they run or serve. Only the names travel, never a value.
 */

export const SCRUB_LIST_ENV = "HUNDREDFOLD_SCRUB_ENV";

/** The value that names `names`, or undefined when there is nothing to scrub. */
export function scrubListValue(names: readonly string[] | undefined): string | undefined {
  const listed = [...new Set((names ?? []).filter((name) => name !== ""))];
  return listed.length === 0 ? undefined : listed.join(",");
}

/** Delete from `env`, in place, every variable the list names, and the list. */
export function scrubListedEnv(env: NodeJS.ProcessEnv): void {
  const listed = env[SCRUB_LIST_ENV];
  delete env[SCRUB_LIST_ENV];
  if (!listed) return;
  for (const name of listed.split(",")) {
    const trimmed = name.trim();
    if (trimmed !== "") delete env[trimmed];
  }
}
