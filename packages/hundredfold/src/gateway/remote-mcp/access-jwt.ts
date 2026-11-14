import crypto from "node:crypto";

/**
 * Verifies the `Cf-Access-Jwt-Assertion` Cloudflare Access attaches to every
 * request it lets through (FR-006). The origin re-verifies rather than
 * trusting the header's presence because the tunnel is not the only way in:
 * `tailscale serve` and the raw LAN port reach the same process from loopback,
 * and a header anyone can type is not an identity.
 *
 * Hand-rolled on `node:crypto` (RS256 over a JWK) instead of a JWT library: a
 * new dependency trips the pnpm age gate, and the whole contract is small enough
 * to test branch by branch.
 */

export type AccessJwtFailure = "no-credential" | "bad-credential" | "expired" | "misconfigured";

export type AccessJwtResult =
  | { ok: true; email: string }
  | { ok: false; reason: AccessJwtFailure; detail: string };

export interface AccessJwtVerifier {
  verify(token: string | undefined): Promise<AccessJwtResult>;
}

export interface AccessJwtVerifierOptions {
  teamDomain: string;
  aud: string;
  /** Injected in tests; defaults to GET `https://<teamDomain>/cdn-cgi/access/certs`. */
  fetchJwks?: (url: string) => Promise<unknown>;
  /** Milliseconds since the epoch; injected in tests. */
  now?: () => number;
}

const LEEWAY_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60_000;
/** An unknown `kid` refetches at most this often, so a forged header cannot hammer the certs endpoint. */
const JWKS_REFETCH_FLOOR_MS = 60_000;

function base64urlJson(segment: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`certs endpoint answered ${res.status}`);
  return res.json();
}

function keysFrom(jwks: unknown): Map<string, crypto.KeyObject> {
  const keys = new Map<string, crypto.KeyObject>();
  const list = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list as Array<Record<string, unknown>>) {
    if (typeof jwk?.kid !== "string" || jwk.kty !== "RSA") continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" }));
    } catch {
      /* a malformed key is skipped; a token signed by it then fails as unknown kid */
    }
  }
  return keys;
}

type Failure = Extract<AccessJwtResult, { ok: false }>;
const fail = (reason: AccessJwtFailure, detail: string): Failure => ({ ok: false, reason, detail });

interface ParsedAssertion {
  kid: string;
  claims: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

/** Shape and header checks, before any key is touched. */
function parseAssertion(token: string | undefined): ParsedAssertion | Failure {
  if (!token) return fail("no-credential", "no Cf-Access-Jwt-Assertion header");
  const parts = token.split(".");
  if (parts.length !== 3) return fail("bad-credential", "assertion is not a JWS");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = base64urlJson(rawHeader);
  const claims = base64urlJson(rawPayload);
  if (!header || !claims) return fail("bad-credential", "assertion is not valid JSON");
  // Pinned: `none` and HS256 (with the public key as the secret) are the classic downgrades.
  if (header.alg !== "RS256") return fail("bad-credential", `alg ${String(header.alg)} is not RS256`);
  if (typeof header.kid !== "string") return fail("bad-credential", "assertion has no kid");
  return {
    kid: header.kid,
    claims,
    signingInput: Buffer.from(`${rawHeader}.${rawPayload}`),
    signature: Buffer.from(rawSignature, "base64url"),
  };
}

/** Issuer, audience, time window and identity — only after the signature verified. */
function checkClaims(claims: Record<string, unknown>, issuer: string, aud: string, seconds: number): AccessJwtResult {
  if (claims.iss !== issuer) return fail("bad-credential", "issuer is not this Access team");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) return fail("bad-credential", "audience is not this Access application");
  if (typeof claims.exp !== "number" || seconds > claims.exp + LEEWAY_SECONDS) return fail("expired", "assertion has expired");
  if (typeof claims.nbf === "number" && seconds < claims.nbf - LEEWAY_SECONDS) return fail("bad-credential", "assertion is not yet valid");
  if (typeof claims.email !== "string" || !claims.email) return fail("bad-credential", "assertion carries no email identity");
  return { ok: true, email: claims.email.trim().toLowerCase() };
}

export function createAccessJwtVerifier(options: AccessJwtVerifierOptions): AccessJwtVerifier {
  const certsUrl = `https://${options.teamDomain}/cdn-cgi/access/certs`;
  const issuer = `https://${options.teamDomain}`;
  const fetchJwks = options.fetchJwks ?? defaultFetchJwks;
  const now = options.now ?? Date.now;
  let keys = new Map<string, crypto.KeyObject>();
  let fetchedAt = -Infinity;
  let failedAt = -Infinity;
  let pending: Promise<void> | undefined;

  /** One fetch at a time, however many requests arrive at TTL expiry. A failure
   *  backs off like a success does, so a certs outage costs one fetch a minute
   *  rather than a 5 s timeout on every request (QA of #25). */
  function refresh(): Promise<void> {
    pending ??= (async () => {
      try {
        // Through a resolved promise: a fetcher that throws synchronously would
        // otherwise run `finally` before `??=` assigns, leaving `pending` stuck.
        keys = keysFrom(await Promise.resolve().then(() => fetchJwks(certsUrl)));
        fetchedAt = now();
      } catch {
        failedAt = now();
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  async function keyFor(kid: string): Promise<crypto.KeyObject | "unavailable" | undefined> {
    const wanted = now() - fetchedAt > JWKS_TTL_MS || !keys.has(kid);
    if (wanted && now() - Math.max(fetchedAt, failedAt) > JWKS_REFETCH_FLOOR_MS) await refresh();
    if (keys.size === 0) return "unavailable";
    return keys.get(kid);
  }

  return {
    async verify(token) {
      const parsed = parseAssertion(token);
      if ("ok" in parsed) return parsed;
      const key = await keyFor(parsed.kid);
      if (key === "unavailable") return fail("misconfigured", "Access signing keys could not be fetched");
      if (!key) return fail("bad-credential", "assertion kid is not an Access signing key");
      if (!crypto.verify("RSA-SHA256", parsed.signingInput, key, parsed.signature)) return fail("bad-credential", "signature does not verify");
      return checkClaims(parsed.claims, issuer, options.aud, now() / 1000);
    },
  };
}
