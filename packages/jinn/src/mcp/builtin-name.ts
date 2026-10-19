import { LEGACY_CODENAME, NAMES, nameAliases, type Names } from "../shared/codename.js";

/**
 * The built-in company MCP server is registered with each engine under a name, and that name
 * is a per-instance setting rather than the codename: the agents of an instance carry it in
 * their prompts, skills and permission allow-lists (`mcp__<name>__<tool>`), so it changes
 * only when that instance is switched over, not when the program is upgraded.
 *
 * The setting is `mcpServerName` in the instance's own block of `config.yaml` (the block
 * keyed by the codename, beside `version`). An instance without it was created under the
 * legacy codename, so it keeps that name; an instance created by a build with another
 * codename records its own. Both names stay reserved, so no custom server can take either.
 */

/** Both names the built-in server may be registered under, the current one first. */
export function builtinMcpNames(names: Names = NAMES): string[] {
  return nameAliases((n) => n.codename, names);
}

/** Whether `name` is one of the reserved built-in server names. */
export function isBuiltinMcpName(name: string, names: Names = NAMES): boolean {
  return builtinMcpNames(names).includes(name);
}

/** Why an `mcp:` allowlist leaves the built-in server out, or undefined when it names it under either reserved name (the list may predate the instance's switch-over). */
export function allowlistOmission(employee: { name: string; mcp?: unknown } | undefined, names: Names = NAMES): string | undefined {
  const listed = employee?.mcp;
  if (!Array.isArray(listed) || listed.some((name) => typeof name === "string" && isBuiltinMcpName(name, names))) return undefined;
  return `employee ${employee?.name}'s mcp allowlist omits "${builtinMcpNames(names)[0]}"`;
}

/** The instance block of a config document, under either spelling of the codename. */
type InstanceBlocks = Record<string, { mcpServerName?: unknown } | undefined>;

/** The name this instance registers the built-in server under. */
export function builtinMcpServerName(config: object | undefined, names: Names = NAMES): string {
  for (const key of builtinMcpNames(names)) {
    const configured = (config as InstanceBlocks | undefined)?.[key]?.mcpServerName;
    if (typeof configured === "string" && isBuiltinMcpName(configured, names)) return configured;
  }
  return LEGACY_CODENAME;
}

/** The built-in server in a resolved set, under whichever reserved name it carries. */
export function findBuiltinMcp<T>(
  servers: Record<string, T> | undefined,
  names: Names = NAMES,
): { name: string; spec: T } | undefined {
  if (!servers) return undefined;
  for (const name of builtinMcpNames(names)) {
    if (servers[name] !== undefined) return { name, spec: servers[name] };
  }
  return undefined;
}
