import { NAMES } from "../shared/codename.js";
import { cookieNamespace, parseCookieHeader } from "../gateway/auth-cookies.js";

/** 90 days: the session's absolute lifetime; the idle limit is enforced on the server side. */
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/** `<codename>_user`, namespaced per instance like the operator's cookies (cookies are scoped by host, not port). */
export function userCookieName(jinnHome?: string): string {
  const ns = cookieNamespace(jinnHome);
  const base = `${NAMES.codename}_user`;
  return ns ? `${base}_${ns}` : base;
}

/** `Secure` only when the request arrived over HTTPS, for the reason the operator cookie does the same. */
export function userCookieHeader(token: string, jinnHome?: string, secure = false): string {
  return `${userCookieName(jinnHome)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearUserCookieHeader(jinnHome?: string): string {
  return `${userCookieName(jinnHome)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** The raw session token a request carries, if any. */
export function requestUserToken(headers: Record<string, string | string[] | undefined>, jinnHome?: string): string | undefined {
  const raw = headers.cookie;
  const value = parseCookieHeader(Array.isArray(raw) ? raw[0] : raw)[userCookieName(jinnHome)];
  return value ? value : undefined;
}
