/**
 * `gateway.remoteMcp` — the remote MCP connector (specs/004). Off
 * unless `enabled: true`, and even then every request is refused until the
 * Cloudflare Access pair (`access.teamDomain`, `access.aud`) and at least one
 * allowed email are set: an enabled endpoint with no way to verify a caller
 * fails closed (FR-003) rather than open.
 */
export interface RemoteMcpConfig {
  enabled?: boolean;
  /** The public connector URL, e.g. `https://<host>/mcp` — the RFC 9728 `resource`. */
  resourceUrl?: string;
  /** The Access application whose assertion the origin verifies (FR-006). */
  access?: { teamDomain?: string; aud?: string };
  /** Identities admitted behind the Access policy — defence in depth, required. */
  allowedEmails?: string[];
  /** The per-request cut-off (FR-016): a listed identity is refused on its next call. */
  deniedEmails?: string[];
  /** Exact `Origin` values admitted; empty by default because no real client sends one (FR-007). */
  allowedOrigins?: string[];
}

export interface ResolvedRemoteMcpAuth {
  teamDomain: string;
  aud: string;
  resourceUrl: string | undefined;
  allowedEmails: Set<string>;
  deniedEmails: Set<string>;
  allowedOrigins: Set<string>;
}

const TEAM_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function normalizedEmails(list: string[] | undefined): Set<string> {
  return new Set((list ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function accessPair(config: RemoteMcpConfig | undefined): { teamDomain: string; aud: string } | undefined {
  const teamDomain = trimmed(config?.access?.teamDomain)?.toLowerCase();
  const aud = trimmed(config?.access?.aud);
  return teamDomain && aud && TEAM_DOMAIN.test(teamDomain) ? { teamDomain, aud } : undefined;
}

/** The verification settings, or undefined when they are incomplete (→ `misconfigured`). */
export function resolveRemoteMcpAuth(config: RemoteMcpConfig | undefined): ResolvedRemoteMcpAuth | undefined {
  const pair = accessPair(config);
  const allowedEmails = normalizedEmails(config?.allowedEmails);
  if (!pair || allowedEmails.size === 0) return undefined;
  return {
    ...pair,
    resourceUrl: trimmed(config?.resourceUrl),
    allowedEmails,
    deniedEmails: normalizedEmails(config?.deniedEmails),
    allowedOrigins: new Set((config?.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean)),
  };
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isHttpsUrl(value: unknown): boolean {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function accessProblems(access: unknown): string[] {
  if (access === undefined) return [];
  if (!isMapping(access)) return ["gateway.remoteMcp.access must be a mapping"];
  const problems: string[] = [];
  const { teamDomain, aud } = access;
  if (teamDomain !== undefined && (typeof teamDomain !== "string" || !TEAM_DOMAIN.test(teamDomain.trim()))) {
    problems.push("gateway.remoteMcp.access.teamDomain must be a bare host name such as <team>.cloudflareaccess.com");
  }
  if (aud !== undefined && (typeof aud !== "string" || !aud.trim())) {
    problems.push("gateway.remoteMcp.access.aud must be the Access application's AUD tag");
  }
  return problems;
}

/** Without `resourceUrl` the 401 cannot point claude.ai at the sign-in metadata, and
 *  discovery fails with nothing to say why, so an enabled endpoint needs one. */
function resourceUrlProblems(value: Record<string, unknown>): string[] {
  if (value.resourceUrl === undefined) {
    return value.enabled === true ? ["gateway.remoteMcp.resourceUrl is required when enabled (https://<host>/mcp)"] : [];
  }
  return isHttpsUrl(value.resourceUrl) ? [] : ["gateway.remoteMcp.resourceUrl must be an https URL"];
}

const LIST_KEYS = ["allowedEmails", "deniedEmails", "allowedOrigins"] as const;

const isStringList = (list: unknown): boolean =>
  list === undefined || (Array.isArray(list) && list.every((entry) => typeof entry === "string"));

export function remoteMcpProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return ["gateway.remoteMcp must be a mapping"];
  const problems: string[] = [];
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") problems.push("gateway.remoteMcp.enabled must be a boolean");
  problems.push(...resourceUrlProblems(value));
  problems.push(...accessProblems(value.access));
  problems.push(...LIST_KEYS.filter((key) => !isStringList(value[key])).map((key) => `gateway.remoteMcp.${key} must be a list of strings`));
  return problems;
}
