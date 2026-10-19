import { LEGACY_NAMES, NAMES, nameAliases, type Names } from "./codename.js";

/**
 * Names that cross a process or version boundary: request headers, the marker value a tool
 * call carries, hook-body and org-YAML field names, and the launch flags the gateway puts on
 * its MCP server. Peers on either side of an upgrade disagree about the codename, so a
 * server accepts both spellings and a client sends the current one.
 */

/** `x-jinn-caller-session` for the suffix `caller-session`: what this build sends and reads. */
export function wireHeader(suffix: string, names: Names = NAMES): string {
  return `x-${names.codename}-${suffix}`;
}

/** Every spelling of one header, the current one first. */
export function wireHeaderAliases(suffix: string, names: Names = NAMES): string[] {
  return nameAliases((n) => wireHeader(suffix, n), names);
}

/**
 * The capitalised form a CORS allow-list or an expose-list prints (`X-Jinn-Config-Revision`).
 * Header names are case-insensitive on the wire; the lists are read by people.
 */
export function wireHeaderDisplay(suffix: string, names: Names = NAMES): string {
  return ["X", names.title, ...suffix.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1))].join("-");
}

/** Every capitalised spelling of one header, the current one first. */
export function wireHeaderDisplayAliases(suffix: string, names: Names = NAMES): string[] {
  return nameAliases((n) => wireHeaderDisplay(suffix, n), names);
}

/** The suffix of a header in the legacy spelling (`x-jinn-origin` -> `origin`), or undefined for any other header. */
function legacySuffix(header: string): string | undefined {
  const prefix = `x-${LEGACY_NAMES.codename}-`;
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

/**
 * Give every legacy-named header on an incoming request a current-named twin, in place, so
 * everything downstream reads the current name only. A header sent under both names keeps
 * the current value. Node lower-cases incoming header names. A no-op while the codename is unchanged.
 */
export function adoptLegacyHeaders(
  headers: Record<string, string | string[] | undefined>,
  names: Names = NAMES,
): void {
  if (!names.renamed) return;
  for (const key of Object.keys(headers)) {
    const suffix = legacySuffix(key);
    if (suffix === undefined) continue;
    const current = wireHeader(suffix, names);
    if (headers[current] === undefined) headers[current] = headers[key];
  }
}

/** The value a tool call's marker header carries: `jinn-mcp`. */
export function toolCallMarker(names: Names = NAMES): string {
  return `${names.codename}-mcp`;
}

/** Whether `value` is a tool-call marker from this build or an older one. */
export function isToolCallMarker(value: unknown, names: Names = NAMES): boolean {
  return typeof value === "string" && nameAliases(toolCallMarker, names).includes(value);
}

/** `jinnMcp` in the org YAML, and its current spelling. */
export function orgMcpKey(names: Names = NAMES): string {
  return `${names.codename}Mcp`;
}

/** `--jinn-session-id`: the flag the gateway puts on the MCP server it launches. */
export function mcpFlag(suffix: string, names: Names = NAMES): string {
  return `--${names.codename}-${suffix}`;
}

/** Every spelling of one launch flag, the current one first. */
export function mcpFlagAliases(suffix: string, names: Names = NAMES): string[] {
  return nameAliases((n) => mcpFlag(suffix, n), names);
}

/** `jinnSessionId` in the hook body, and its current spelling. */
export function hookSessionIdKey(names: Names = NAMES): string {
  return `${names.codename}SessionId`;
}

/** The session id of a hook post, whichever spelling the relay that sent it used. */
export function readHookSessionId(body: unknown, names: Names = NAMES): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of nameAliases(hookSessionIdKey, names)) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}
