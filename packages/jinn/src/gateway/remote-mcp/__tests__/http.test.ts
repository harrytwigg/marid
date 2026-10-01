import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { beforeAll, describe, expect, it } from "vitest";

// Isolated home BEFORE the imports that open the session DB.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-mcp-http-"));

type Http = typeof import("../http.js");
type Registry = typeof import("../../../sessions/registry.js");
let mod: Http;
let registry: Registry;

beforeAll(async () => {
  mod = await import("../http.js");
  registry = await import("../../../sessions/registry.js");
});

const ENABLED = {
  enabled: true,
  resourceUrl: "https://gw.example.com/mcp",
  access: { teamDomain: "team.example.com", aud: "aud-1" },
  allowedEmails: ["op@example.com"],
  deniedEmails: ["gone@example.com"],
};

function config(remoteMcp: unknown = ENABLED) {
  return { gateway: { port: 7777, host: "0.0.0.0", remoteMcp }, engines: { default: "claude" } } as never;
}

/** The verifier stand-in: the token IS the email, or a named failure. */
const verifier = {
  async verify(token: string | undefined) {
    if (!token) return { ok: false as const, reason: "no-credential" as const, detail: "none" };
    if (token === "bad") return { ok: false as const, reason: "bad-credential" as const, detail: "bad" };
    return { ok: true as const, email: token };
  },
};

const gatewayCalls: string[] = [];
const fetchFn = (async (input: string | URL, init?: RequestInit) => {
  gatewayCalls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname} ${JSON.stringify(init?.headers ?? {})}`);
  return new Response(JSON.stringify({ workItems: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

function handler(remoteMcp: unknown = ENABLED) {
  return mod.createRemoteMcpHandler({ getConfig: () => config(remoteMcp), gatewayAuthToken: "gateway-token", createVerifier: () => verifier, fetchFn });
}

async function call(
  h: ReturnType<Http["createRemoteMcpHandler"]>,
  { method = "POST", url = "/mcp", headers = {}, body }: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown },
) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]), {
    method, url, headers: { "content-type": "application/json", ...headers },
  }) as unknown as http.IncomingMessage;
  let status = 0;
  let resHeaders: Record<string, string> = {};
  let text = "";
  const res = {
    writeHead(code: number, h: Record<string, string> = {}) { status = code; resHeaders = h; return this; },
    end(chunk?: string) { if (chunk) text += chunk; },
  } as unknown as http.ServerResponse;
  const handled = h.handle(req, res);
  if (handled) await handled;
  return { handled: handled !== false, status, headers: resHeaders, body: text ? JSON.parse(text) : undefined };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const auth = { "cf-access-jwt-assertion": "op@example.com" };

describe("/mcp transport and auth order (D6, D7)", () => {
  it("leaves every other path alone", async () => {
    expect((await call(handler(), { url: "/api/status" })).handled).toBe(false);
  });

  it("answers 404 JSON, not the dashboard, while disabled (US3-1)", async () => {
    const r = await call(handler({ ...ENABLED, enabled: false }), { headers: auth, body: init });
    expect(r).toMatchObject({ handled: true, status: 404, body: { error: "Not found" } });
  });

  it("refuses GET with 405 and Allow: POST", async () => {
    const r = await call(handler(), { method: "GET", headers: auth });
    expect(r.status).toBe(405);
    expect(r.headers.Allow).toBe("POST");
  });

  it("refuses any browser Origin before looking at credentials (FR-007)", async () => {
    expect((await call(handler(), { headers: { ...auth, origin: "https://evil.example.com" }, body: init })).body.reason).toBe("origin-refused");
  });

  it("admits an allow-listed Origin", async () => {
    const r = await call(handler({ ...ENABLED, allowedOrigins: ["https://claude.ai"] }), { headers: { ...auth, origin: "https://claude.ai" }, body: init });
    expect(r.status).toBe(200);
  });

  it("refuses a non-JSON POST (FR-007)", async () => {
    expect((await call(handler(), { headers: { ...auth, "content-type": "text/plain" }, body: init })).status).toBe(415);
  });

  it("fails closed as misconfigured without the Access pair or an allowed email (FR-003)", async () => {
    const r = await call(handler({ enabled: true, access: { teamDomain: "team.example.com" }, allowedEmails: ["op@example.com"] }), { headers: auth, body: init });
    expect(r).toMatchObject({ status: 503, body: { reason: "misconfigured" } });
    const noEmails = await call(handler({ ...ENABLED, allowedEmails: [] }), { headers: auth, body: init });
    expect(noEmails.status).toBe(503);
  });

  it("challenges a caller with no assertion, pointing at the protected-resource metadata (FR-009)", async () => {
    const r = await call(handler(), { body: init });
    expect(r.status).toBe(401);
    expect(r.headers["WWW-Authenticate"]).toBe('Bearer resource_metadata="https://gw.example.com/.well-known/oauth-protected-resource/mcp"');
  });

  it("marks an invalid assertion as invalid_token", async () => {
    const r = await call(handler(), { headers: { "cf-access-jwt-assertion": "bad" }, body: init });
    expect(r.status).toBe(401);
    expect(r.headers["WWW-Authenticate"]).toContain('error="invalid_token"');
  });

  it("cuts off a denied identity on its next call, and refuses one not on the allow-list (FR-016)", async () => {
    expect((await call(handler(), { headers: { "cf-access-jwt-assertion": "gone@example.com" }, body: init })).body.reason).toBe("cut-off");
    expect((await call(handler(), { headers: { "cf-access-jwt-assertion": "stranger@example.com" }, body: init })).body.reason).toBe("not-allowed");
  });

  it("initializes, echoing a supported protocol version", async () => {
    const r = await call(handler(), { headers: auth, body: init });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "jinn" } });
  });

  it("answers an unsupported protocol version with the newest it speaks", async () => {
    const r = await call(handler(), { headers: auth, body: { ...init, params: { protocolVersion: "1999-01-01" } } });
    expect(r.body.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers a notification with 202 and no body", async () => {
    const r = await call(handler(), { headers: auth, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(r).toMatchObject({ status: 202, body: undefined });
  });

  it("refuses a batch and an unparseable body", async () => {
    expect((await call(handler(), { headers: auth, body: [init] })).status).toBe(400);
    expect((await call(handler(), { headers: auth, body: "{nope" })).body.error.code).toBe(-32700);
  });

  it("lists the profile only", async () => {
    const r = await call(handler(), { headers: auth, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const names = (r.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("list_work_items");
    expect(names).not.toContain("spawn_session");
    expect(names).not.toContain("read_knowledge");
  });

  it("serves the instance's knowledge wording on search_knowledge and follows a config reload", async () => {
    let knowledge: { guidance?: string; missHint?: string } | undefined = { guidance: "FIRST-GUIDANCE" };
    const h = mod.createRemoteMcpHandler({
      getConfig: () => ({ ...(config() as object), ...(knowledge ? { knowledge } : {}) }) as never,
      gatewayAuthToken: "gateway-token",
      createVerifier: () => verifier,
      fetchFn,
    });
    const searchDescription = async () => {
      const r = await call(h, { headers: auth, body: { jsonrpc: "2.0", id: 9, method: "tools/list" } });
      return (r.body.result.tools as Array<{ name: string; description: string }>).find((tool) => tool.name === "search_knowledge")!.description;
    };
    expect(await searchDescription()).toContain("FIRST-GUIDANCE");
    knowledge = { guidance: "SECOND-GUIDANCE" };
    const reloaded = await searchDescription();
    expect(reloaded).toContain("SECOND-GUIDANCE");
    expect(reloaded).not.toContain("FIRST-GUIDANCE");
    knowledge = undefined;
    expect(await searchDescription()).toBe("Search knowledge/ and docs/ markdown; snippets only.");
  });

  it("runs a tool as the identity's anchor session, reused across calls", async () => {
    gatewayCalls.length = 0;
    const h = handler();
    const listCall = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_work_items", arguments: {} } };
    await call(h, { headers: auth, body: listCall });
    await call(h, { headers: auth, body: listCall });
    const anchor = registry.getSessionBySourceRef("remote-mcp:op@example.com");
    expect(anchor).toMatchObject({ source: "remote-mcp", employee: null });
    expect(gatewayCalls).toHaveLength(2);
    for (const line of gatewayCalls) {
      expect(line).toContain("GET /api/work-items");
      expect(line).toContain(anchor!.id);
    }
  });

  it("serves protected-resource metadata naming the connector URL exactly", async () => {
    const r = await call(handler(), { method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(r.body).toEqual({ resource: "https://gw.example.com/mcp", authorization_servers: ["https://gw.example.com"], bearer_methods_supported: ["header"] });
  });

  it("reports status without a credential in it", async () => {
    const h = handler();
    await call(h, { body: init });
    let body = "";
    const res = { writeHead() { return this; }, end(chunk?: string) { body += chunk ?? ""; } } as unknown as http.ServerResponse;
    expect(h.serveStatus({ method: "GET", url: "/api/remote-mcp" } as http.IncomingMessage, res)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({ enabled: true, lastRefusal: { reason: "no-credential" } });
    expect(body).not.toContain("op@example.com");
  });

  it("records a call to a tool outside the profile as tool-not-in-profile", async () => {
    const h = handler();
    await call(h, { headers: auth, body: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "spawn_session", arguments: {} } } });
    let body = "";
    const res = { writeHead() { return this; }, end(chunk?: string) { body += chunk ?? ""; } } as unknown as http.ServerResponse;
    h.serveStatus({ method: "GET", url: "/api/remote-mcp" } as http.IncomingMessage, res);
    expect(JSON.parse(body)).toMatchObject({ lastOutcome: "tool-not-in-profile", lastRefusal: { reason: "tool-not-in-profile" } });
  });

  it("records a body refused after authentication", async () => {
    const h = handler();
    await call(h, { headers: auth, body: "{nope" });
    let body = "";
    const res = { writeHead() { return this; }, end(chunk?: string) { body += chunk ?? ""; } } as unknown as http.ServerResponse;
    h.serveStatus({ method: "GET", url: "/api/remote-mcp" } as http.IncomingMessage, res);
    expect(JSON.parse(body)).toMatchObject({ lastRefusal: { reason: "bad-request" } });
  });
});
