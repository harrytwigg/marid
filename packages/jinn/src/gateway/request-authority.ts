import type { IncomingHttpHeaders } from "node:http";

/**
 * Reading a request's authority (its Host) and deciding whether a browser
 * Origin names it. Shared by the HTTP same-origin trust in api.ts and the
 * terminal socket's origin check in upgrade-guards.ts, so both parse a Host
 * header the same strict way.
 */

/** The request, as far as reading its headers goes. A raw upgrade request carries rawHeaders; a test double may not. */
export type RequestHeaders = { headers: IncomingHttpHeaders; rawHeaders?: string[] };

export type RequestAuthority = {
  hostname: string;
  /** The port the header named, or 80 when it named none. */
  port: number;
  /** Whether the header named a port. Without one it means the origin scheme's default. */
  explicitPort: boolean;
};

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

export function requestHeaderValues(req: RequestHeaders, name: string): string[] {
  const lowerName = name.toLowerCase();
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    const values: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === lowerName) values.push(req.rawHeaders[index + 1] ?? "");
    }
    return values;
  }
  const raw = req.headers[lowerName];
  if (Array.isArray(raw)) return raw;
  return typeof raw === "string" ? [raw] : [];
}

export function singleRequestHeader(req: RequestHeaders, name: string): string | undefined {
  const values = requestHeaderValues(req, name);
  if (values.length !== 1) return undefined;
  const value = values[0];
  return value === value.trim() && value.length > 0 ? value : undefined;
}

const BRACKETED_AUTHORITY = /^\[([0-9a-f:.]+)\](?::([0-9]+))?$/i;
const PLAIN_AUTHORITY = /^([a-z0-9._-]+)(?::([0-9]+))?$/i;

function isPlausibleHostValue(raw: string | undefined): raw is string {
  return !!raw && raw.length <= 255 && /^[\x21-\x7e]+$/.test(raw) && !/[%/@\\?#,]/.test(raw);
}

function isWellFormedHostname(hostname: string): boolean {
  return !!hostname && !hostname.startsWith(".") && !hostname.endsWith(".") && !hostname.includes("..");
}

function isBareAuthorityUrl(raw: string): boolean {
  try {
    const parsed = new URL(`http://${raw}`);
    return !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

/** Parse one `host[:port]` value, refusing anything a Host header should never hold. */
export function parseAuthority(raw: string | undefined): RequestAuthority | undefined {
  if (!isPlausibleHostValue(raw)) return undefined;
  const match = (raw.startsWith("[") ? BRACKETED_AUTHORITY : PLAIN_AUTHORITY).exec(raw);
  if (!match) return undefined;
  const hostname = match[1].toLowerCase();
  const rawPort = match[2];
  const port = rawPort === undefined ? 80 : Number(rawPort);
  if (!isWellFormedHostname(hostname) || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return isBareAuthorityUrl(raw) ? { hostname, port, explicitPort: rawPort !== undefined } : undefined;
}

/** The request's own Host, if it sent exactly one well-formed Host header. */
export function parseRequestAuthority(req: RequestHeaders): RequestAuthority | undefined {
  return parseAuthority(singleRequestHeader(req, "host"));
}

/**
 * Whether a browser Origin names this authority. Plain http only unless the
 * caller admits https too: the loopback same-origin trust in api.ts never sees
 * TLS, while a terminal behind a TLS-terminating proxy does. A Host with no
 * port stands for the origin scheme's default port.
 */
export function originMatchesAuthority(
  origin: string,
  authority: RequestAuthority,
  options: { schemes?: readonly ("http:" | "https:")[] } = {},
): boolean {
  const schemes: readonly string[] = options.schemes ?? ["http:"];
  const parsed = parseOrigin(origin);
  if (!parsed || !schemes.includes(parsed.protocol)) return false;
  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "") === authority.hostname
    && port === (authority.explicitPort ? authority.port : defaultPort);
}

/** A URL for a credential-free, non-opaque origin, or nothing. */
function parseOrigin(origin: string): URL | undefined {
  try {
    const parsed = new URL(origin);
    return parsed.username || parsed.password || parsed.origin === "null" ? undefined : parsed;
  } catch {
    return undefined;
  }
}
