import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAccessJwtVerifier } from "../access-jwt.js";

const TEAM = "team.example.com";
const AUD = "aud-tag-1";
const NOW = 1_800_000_000_000;

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" }] };

function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}, key = privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT", ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${s}`;
}

const good = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 300, nbf: NOW / 1000 - 5, email: "Op@Example.com" };

function verifier(fetchJwks: (url: string) => Promise<unknown> = async () => jwks) {
  return createAccessJwtVerifier({ teamDomain: TEAM, aud: AUD, fetchJwks, now: () => NOW });
}

describe("Access JWT verification (FR-006)", () => {
  it("accepts a correctly signed assertion for this team and application, lower-casing the email", async () => {
    expect(await verifier().verify(sign(good))).toEqual({ ok: true, email: "op@example.com" });
  });

  it("fetches the team's certs endpoint", async () => {
    const urls: string[] = [];
    await verifier(async (url) => { urls.push(url); return jwks; }).verify(sign(good));
    expect(urls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it.each([
    ["no token", undefined, "no-credential"],
    ["not a JWS", "abc.def", "bad-credential"],
    ["alg none", sign(good, { alg: "none" }), "bad-credential"],
    ["alg HS256", sign(good, { alg: "HS256" }), "bad-credential"],
    ["unknown kid", sign(good, { kid: "k9" }), "bad-credential"],
    ["signed by another key", sign(good, {}, other.privateKey), "bad-credential"],
    ["another issuer", sign({ ...good, iss: "https://evil.example.com" }), "bad-credential"],
    ["another audience", sign({ ...good, aud: ["someone-else"] }), "bad-credential"],
    ["expired beyond leeway", sign({ ...good, exp: NOW / 1000 - 61 }), "expired"],
    ["no exp", sign({ ...good, exp: undefined }), "expired"],
    ["not yet valid beyond leeway", sign({ ...good, nbf: NOW / 1000 + 61 }), "bad-credential"],
    ["no email identity (a service token)", sign({ ...good, email: undefined, common_name: "svc" }), "bad-credential"],
  ])("refuses %s", async (_label, token, reason) => {
    const result = await verifier().verify(token as string | undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("tolerates clock skew inside the 60 s leeway", async () => {
    expect((await verifier().verify(sign({ ...good, exp: NOW / 1000 - 30 }))).ok).toBe(true);
  });

  it("accepts a string aud as well as an array", async () => {
    expect((await verifier().verify(sign({ ...good, aud: AUD }))).ok).toBe(true);
  });

  it("fails closed as misconfigured when the signing keys cannot be fetched", async () => {
    const result = await verifier(async () => { throw new Error("down"); }).verify(sign(good));
    expect(result).toMatchObject({ ok: false, reason: "misconfigured" });
  });

  it("does not refetch the keys on every call", async () => {
    let fetches = 0;
    const v = verifier(async () => { fetches += 1; return jwks; });
    await v.verify(sign(good));
    await v.verify(sign(good));
    await v.verify(sign(good, { kid: "k9" }));
    expect(fetches).toBe(1);
  });

  it("backs off after a failed fetch instead of refetching on every request", async () => {
    let fetches = 0;
    const v = verifier(async () => { fetches += 1; throw new Error("down"); });
    await v.verify(sign(good));
    await v.verify(sign(good));
    expect(fetches).toBe(1);
  });

  it("shares one fetch between concurrent requests", async () => {
    let fetches = 0;
    const v = verifier(async () => { fetches += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return jwks; });
    const results = await Promise.all([v.verify(sign(good)), v.verify(sign(good)), v.verify(sign(good))]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetches).toBe(1);
  });

  it("keeps refreshing after a fetcher that throws synchronously", async () => {
    let fetches = 0;
    let clock = NOW;
    const v = createAccessJwtVerifier({ teamDomain: TEAM, aud: AUD, now: () => clock, fetchJwks: ((): Promise<unknown> => { fetches += 1; throw new Error("sync"); }) });
    await v.verify(sign(good));
    clock += 61_000;
    await v.verify(sign(good));
    expect(fetches).toBe(2);
  });
});
