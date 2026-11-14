import net from "node:net";
import type { IncomingMessage } from "node:http";
import { normaliseIp, parseTrustEntry, type ProxyTrustConfig } from "../shared/proxy-trust-config.js";
import { isLoopback } from "./hook-endpoint.js";
import { singleRequestHeader } from "./request-authority.js";

/**
 * Who a request really came from, for the one job of keying sign-in rate limits and recording where a session
 * was opened. Forwarded headers are believed only when the direct peer is in the configured `trustedProxies`;
 * everything else in the gateway that asks "is this peer local?" keeps reading the socket.
 */
export interface ClientAddress {
  /** The resolved address, or undefined when the socket gave none. */
  address: string | undefined;
  /**
   * The address stands for many clients (none known, a loopback peer, or a trusted proxy itself), so it earns no
   * per-address bucket and no success exemption.
   */
  shared: boolean;
}

type RequestLike = Pick<IncomingMessage, "headers" | "socket"> & { rawHeaders?: string[] };

interface Compiled {
  list: net.BlockList | undefined;
  header: string | undefined;
}

let cached: { key: string; compiled: Compiled } | undefined;

const headerOf = (trust: ProxyTrustConfig | undefined): string | undefined =>
  typeof trust?.clientIpHeader === "string" && trust.clientIpHeader !== "" ? trust.clientIpHeader.toLowerCase() : undefined;

/** The config compiled for lookups, rebuilt only when its value changes (config.yaml reloads while the gateway runs). */
function compile(trust: ProxyTrustConfig | undefined): Compiled {
  const proxies = Array.isArray(trust?.trustedProxies) ? trust.trustedProxies : [];
  const header = headerOf(trust);
  const key = JSON.stringify([proxies, header]);
  if (cached?.key === key) return cached.compiled;
  // An entry that does not parse trusts nothing: fewer proxies is the safe side.
  const entries = proxies.map(parseTrustEntry).filter((entry) => entry !== undefined);
  const list = new net.BlockList();
  for (const entry of entries) list.addSubnet(entry.address, entry.prefix, entry.family);
  const compiled = { list: entries.length > 0 ? list : undefined, header };
  cached = { key, compiled };
  return compiled;
}

const familyOf = (address: string): "ipv4" | "ipv6" => (net.isIPv4(address) ? "ipv4" : "ipv6");
const isTrusted = (list: net.BlockList | undefined, address: string): boolean => !!list && net.isIP(address) !== 0 && list.check(address, familyOf(address));

/** `1.2.3.4`, `1.2.3.4:80`, `[2001:db8::1]:443`, `[2001:db8::1]` or a bare IPv6 address, as one address; undefined when it is none. */
function addressOfHop(raw: string): string | undefined {
  const text = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) return net.isIPv6(bracketed[1]!) ? normaliseIp(bracketed[1]!) : undefined;
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  return normaliseIp(withPort ? withPort[1]! : text);
}

function headerValue(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The single value of a header that must appear exactly once and hold exactly one address. */
function singleHeaderAddress(req: RequestLike, name: string): string | undefined {
  const value = singleRequestHeader(req, name);
  return value === undefined || value.includes(",") ? undefined : normaliseIp(value);
}

/** Walk `X-Forwarded-For` from the right: the first hop that is not a trusted proxy is the client. */
function forwardedForAddress(req: RequestLike, peer: string, list: net.BlockList | undefined): string {
  const value = headerValue(req, "x-forwarded-for");
  if (value === undefined) return peer;
  const hops = value.split(",");
  let nearestTrusted = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = addressOfHop(hops[i]!);
    if (hop === undefined) return nearestTrusted; // unreadable: believe nothing further left
    if (!isTrusted(list, hop)) return hop;
    nearestTrusted = hop;
  }
  return nearestTrusted; // every hop was one of ours: the leftmost
}

export function resolveClientAddress(req: RequestLike, trust: ProxyTrustConfig | undefined): ClientAddress {
  const raw = req.socket.remoteAddress;
  if (raw === undefined) return { address: undefined, shared: true };
  const peer = normaliseIp(raw) ?? raw.trim().toLowerCase();
  const { list, header } = compile(trust);
  let address = peer;
  if (isTrusted(list, peer)) {
    address = header !== undefined ? (singleHeaderAddress(req, header) ?? peer) : forwardedForAddress(req, peer, list);
  }
  return { address, shared: isLoopback(address) || isTrusted(list, address) };
}
