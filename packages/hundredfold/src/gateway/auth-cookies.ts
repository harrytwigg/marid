import path from "node:path";
import { isDefaultHome } from "../shared/home.js";
import { LEGACY_CODENAME, NAMES, currentInstanceName, legacyInstanceName } from "../shared/codename.js";
import { readEnv } from "../shared/codename-env.js";

export const AUTH_COOKIE = `${NAMES.codename}_auth`;
export const AUTH_DEVICE_COOKIE = `${NAMES.codename}_device`;
/** The same cookies under the legacy codename: a browser paired before a rename holds those. */
const LEGACY_AUTH_COOKIE = `${LEGACY_CODENAME}_auth`;
const LEGACY_AUTH_DEVICE_COOKIE = `${LEGACY_CODENAME}_device`;

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const rawValue = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

/**
 * Cookies are scoped by host but NOT by port (RFC 6265), so two gateway
 * instances on the same host (e.g. one behind `tailscale serve`) would clobber
 * each other's `hundredfold_auth`/`hundredfold_device` cookie and log each other out. Namespace
 * the cookie name per instance to keep their sessions independent. The default
 * `~/.hundredfold` home keeps the bare names (no forced re-pair on upgrade); every
 * other explicit home is namespaced, including throwaway sandbox homes.
 */
export function cookieNamespace(hundredfoldHome?: string): string {
  const home = hundredfoldHome ?? readEnv(process.env, "HOME"); // footgun: ok the same fallback the cookie name always took
  if (!home) return "";
  const resolved = path.resolve(home);
  if (isDefaultHome(resolved)) return "";
  // Named after the instance, which a home an older build created carries under the old spelling.
  const base = currentInstanceName(path.basename(resolved).replace(/^\./, ""));
  return base.replace(/[^A-Za-z0-9_-]/g, "") || "instance";
}

export function authCookieName(hundredfoldHome?: string): string {
  const ns = cookieNamespace(hundredfoldHome);
  return ns ? `${AUTH_COOKIE}_${ns}` : AUTH_COOKIE;
}

export function authDeviceCookieName(hundredfoldHome?: string): string {
  const ns = cookieNamespace(hundredfoldHome);
  return ns ? `${AUTH_DEVICE_COOKIE}_${ns}` : AUTH_DEVICE_COOKIE;
}

/** What an older build named this instance's cookies: its codename in the prefix and in the namespace. Equal to the current names while no rename is in effect. */
function legacyCookieNames(hundredfoldHome?: string): { auth: string; device: string } {
  const ns = cookieNamespace(hundredfoldHome);
  const legacyNs = ns ? legacyInstanceName(ns) : "";
  return {
    auth: legacyNs ? `${LEGACY_AUTH_COOKIE}_${legacyNs}` : LEGACY_AUTH_COOKIE,
    device: legacyNs ? `${LEGACY_AUTH_DEVICE_COOKIE}_${legacyNs}` : LEGACY_AUTH_DEVICE_COOKIE,
  };
}

/** The pair of cookies a request carries: under the current names, else under the legacy ones. */
export function requestAuthCookies(
  parsed: Record<string, string | undefined>,
  hundredfoldHome?: string,
): { secret: string | undefined; deviceId: string | undefined; legacy: boolean } {
  const legacy = legacyCookieNames(hundredfoldHome);
  const current = { secret: parsed[authCookieName(hundredfoldHome)], deviceId: parsed[authDeviceCookieName(hundredfoldHome)] };
  const renamed = legacy.auth !== authCookieName(hundredfoldHome);
  if (!renamed || current.secret !== undefined || current.deviceId !== undefined) return { ...current, legacy: false };
  return { secret: parsed[legacy.auth], deviceId: parsed[legacy.device], legacy: true };
}

/**
 * Set-Cookie headers that move a browser paired before a rename onto the current cookie names:
 * the same values under the new names, and the legacy cookies expired. Empty when the request
 * already carries the current names (or no rename is in effect), so it costs nothing after the first load.
 * `secure` may be a function, asked only when there is something to set.
 */
export function legacyAuthCookieMigration(
  headers: Record<string, string | string[] | undefined>,
  hundredfoldHome?: string,
  secure: boolean | (() => boolean) = false,
): string[] {
  const cookieRaw = headers.cookie;
  const { secret, deviceId, legacy } = requestAuthCookies(parseCookieHeader(Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw), hundredfoldHome);
  if (!legacy || secret === undefined || deviceId === undefined) return [];
  const names = legacyCookieNames(hundredfoldHome);
  return [
    ...authCookieHeaders(secret, deviceId, hundredfoldHome, typeof secure === "function" ? secure() : secure),
    `${names.auth}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    `${names.device}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
}

/**
 * `Secure` is conditional, not unconditional, and the condition matters.
 *
 * Marking the cookie `Secure` always would break every plain-HTTP listener the
 * gateway still legitimately serves — `http://<lan-ip>:<port>` is not a secure
 * context, so the browser would silently drop the cookie and the operator could
 * never log in there. Marking it only when the session was established over
 * HTTPS gives a browser paired through a tunnel a cookie it will never send in
 * cleartext, while a browser paired over the LAN keeps working exactly as before.
 *
 * This matters because the cookie's `Max-Age` is a year: once a browser has
 * paired through a public hostname, any later plaintext request to that host —
 * a typed URL, a stale bookmark, an `http://` link — would otherwise put a
 * long-lived credential on the wire before the redirect to HTTPS arrives.
 */
function cookieAttributes(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
}

export function authCookieHeader(token: string, hundredfoldHome?: string, secure = false): string {
  return `${authCookieName(hundredfoldHome)}=${encodeURIComponent(token)}; ${cookieAttributes(secure)}`;
}

export function authDeviceCookieHeader(deviceId: string, hundredfoldHome?: string, secure = false): string {
  return `${authDeviceCookieName(hundredfoldHome)}=${encodeURIComponent(deviceId)}; ${cookieAttributes(secure)}`;
}

export function authCookieHeaders(secret: string, deviceId: string, hundredfoldHome?: string, secure = false): string[] {
  return [authCookieHeader(secret, hundredfoldHome, secure), authDeviceCookieHeader(deviceId, hundredfoldHome, secure)];
}

export function clearAuthCookieHeader(hundredfoldHome?: string): string {
  return `${authCookieName(hundredfoldHome)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearAuthDeviceCookieHeader(hundredfoldHome?: string): string {
  return `${authDeviceCookieName(hundredfoldHome)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearAuthCookieHeaders(hundredfoldHome?: string): string[] {
  const legacy = legacyCookieNames(hundredfoldHome);
  const expire = (name: string): string => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return [...new Set([
    clearAuthCookieHeader(hundredfoldHome),
    clearAuthDeviceCookieHeader(hundredfoldHome),
    expire(legacy.auth),
    expire(legacy.device),
  ])];
}

