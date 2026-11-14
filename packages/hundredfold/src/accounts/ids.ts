import crypto from "node:crypto";
import { KEPT_DOMAINS } from "../shared/legacy/names.js";

/** `<prefix>_` plus 12 hex characters, the shape every account row id has. */
export function newId(prefix: "usr" | "utk" | "uss"): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

/** A 32-byte random token, the raw value an invite link, reset link or session cookie carries. */
export function newRawToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Only this hash is stored, as the pairing code's is. */
export function hashToken(raw: string, domain: "token" | "session"): string {
  return crypto.createHash("sha256").update(`${KEPT_DOMAINS.userCredential}-${domain}:${raw}`).digest("hex");
}

export const isoNow = (now: number): string => new Date(now).toISOString();
