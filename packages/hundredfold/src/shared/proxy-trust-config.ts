import net from "node:net";

/**
 * `gateway.trustedProxies` and `gateway.clientIpHeader`: which direct peers may say who the real client is.
 * Kept beside `config-types.ts` so the schema can grow without pushing that file past its size budget; the
 * type, the parsing and the validation live together, and `gateway/client-address.ts` reads the same parser.
 */
export interface ProxyTrustConfig {
  /** IP addresses or CIDR ranges (IPv4 and IPv6) of the reverse proxies and tunnels in front of the gateway. Default: none. */
  trustedProxies?: string[];
  /** The one request header a trusted proxy sets to the real client address (for example `cf-connecting-ip`). */
  clientIpHeader?: string;
}

/** A parsed trust entry: a single address (`prefix` is the full width) or a subnet. */
export interface TrustEntry { address: string; family: "ipv4" | "ipv6"; prefix: number }

const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * An IP address in one canonical spelling, or undefined when it is not an address. IPv6 is compressed and
 * lowercased, and an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, in either spelling) becomes the IPv4 one, so a
 * peer, a header value and a list entry for the same host always compare equal. A zone id is not accepted.
 */
export function normaliseIp(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  if (text.includes("%")) return undefined;
  const family = net.isIP(text);
  if (family === 4) return text;
  if (family !== 6) return undefined;
  let canonical = text;
  try {
    canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const dotted = MAPPED_DOTTED.exec(canonical);
  if (dotted) return net.isIPv4(dotted[1]!) ? dotted[1] : undefined;
  const hex = MAPPED_HEX.exec(canonical);
  if (!hex) return canonical;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** The width of an address family's prefix, in bits. */
const WIDTH = { ipv4: 32, ipv6: 128 } as const;

/** The prefix length an entry names, as a number, for a given family; undefined when out of range. */
function prefixOf(prefixPart: string | undefined, family: "ipv4" | "ipv6", mapped: boolean): number | undefined {
  if (prefixPart === undefined) return WIDTH[family];
  if (!/^\d{1,3}$/.test(prefixPart)) return undefined;
  // A subnet written in mapped form (`::ffff:10.0.0.0/104`) is the IPv4 subnet with 96 fewer bits.
  const prefix = Number(prefixPart) - (mapped && family === "ipv4" ? 96 : 0);
  return prefix >= 0 && prefix <= WIDTH[family] ? prefix : undefined;
}

/** One `trustedProxies` entry (an address or `address/prefix`), or undefined when it is neither. */
export function parseTrustEntry(raw: unknown): TrustEntry | undefined {
  if (typeof raw !== "string") return undefined;
  const slash = raw.indexOf("/");
  const addressPart = (slash < 0 ? raw : raw.slice(0, slash)).trim();
  const address = normaliseIp(addressPart);
  if (address === undefined) return undefined;
  const family = net.isIPv4(address) ? "ipv4" : "ipv6";
  const prefix = prefixOf(slash < 0 ? undefined : raw.slice(slash + 1), family, /^::ffff:/i.test(addressPart));
  return prefix === undefined ? undefined : { address, family, prefix };
}

/** Problems with the proxy-trust keys of the `gateway` block, for the config loader. */
export function proxyTrustProblems(gateway: Record<string, unknown>): string[] {
  const { trustedProxies, clientIpHeader } = gateway;
  const problems = trustedProxiesProblems(trustedProxies);
  if (clientIpHeader !== undefined && (typeof clientIpHeader !== "string" || !/^[a-z0-9-]+$/i.test(clientIpHeader))) {
    problems.push(`gateway.clientIpHeader must be a single HTTP header name (got ${JSON.stringify(clientIpHeader)})`);
  }
  return problems;
}

function trustedProxiesProblems(trustedProxies: unknown): string[] {
  if (trustedProxies === undefined) return [];
  if (!Array.isArray(trustedProxies)) {
    return [`gateway.trustedProxies must be a list of IP addresses or CIDR ranges (got ${typeof trustedProxies})`];
  }
  return trustedProxies
    .filter((entry) => parseTrustEntry(entry) === undefined)
    .map((entry) => `gateway.trustedProxies entry ${JSON.stringify(entry)} is not a valid IP address or CIDR range`);
}
