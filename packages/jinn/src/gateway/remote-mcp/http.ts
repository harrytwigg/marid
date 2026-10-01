import type http from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { handleMcpRequest } from "../../mcp/server.js";
import type { JinnMcpTool } from "../../mcp/toolkit.js";
import { logger } from "../../shared/logger.js";
import { resolveRemoteMcpAuth, type ResolvedRemoteMcpAuth } from "../../shared/remote-mcp-config.js";
import type { JinnConfig } from "../../shared/types.js";
import { createAccessJwtVerifier, type AccessJwtResult, type AccessJwtVerifier } from "./access-jwt.js";
import { ensureRemoteMcpAnchor } from "./principal.js";
import { buildRemoteMcpTools } from "./profile.js";

/**
 * The remote MCP endpoint (specs/004): MCP streamable HTTP at `/mcp`,
 * JSON responses only — every Jinn tool is request/response, so there is no
 * stream to hold open through Cloudflare's proxy. Stateless: no `Mcp-Session-Id`.
 *
 * Checks run cheapest-first and every refusal is logged with a reason code
 * (FR-014), never with the credential. The tool calls themselves go back into
 * this gateway over loopback AS the connector's anchor session, so every
 * session guard in api.ts applies to them unchanged.
 */

export const REMOTE_MCP_PATH = "/mcp";
const PRM_PATHS = new Set(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]);
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 1024 * 1024;

export type RemoteMcpReason =
  | "disabled" | "method" | "origin-refused" | "content-type" | "misconfigured" | "no-credential"
  | "bad-credential" | "expired" | "cut-off" | "not-allowed" | "bad-request" | "tool-not-in-profile";

export interface RemoteMcpStatus {
  enabled: boolean;
  lastRequestAt: string | null;
  lastOutcome: string | null;
  lastRefusal: { at: string; reason: RemoteMcpReason } | null;
}

export interface RemoteMcpHandlerDeps {
  getConfig: () => JinnConfig;
  gatewayAuthToken: string;
  /** Injected in tests. */
  createVerifier?: (auth: ResolvedRemoteMcpAuth) => AccessJwtVerifier;
  fetchFn?: typeof fetch;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function loopbackUrl(config: JinnConfig): string {
  const host = config.gateway.host;
  const bindHost = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${bindHost.includes(":") ? `[${bindHost}]` : bindHost}:${config.gateway.port}`;
}

interface Refusal {
  code: number;
  reason: RemoteMcpReason;
  detail: string;
  headers?: Record<string, string>;
  /** The verified identity, once there is one — logged so a refusal names its principal (FR-014). */
  email?: string;
  /** A JSON-RPC error body in place of the plain `{ error, reason }` one. */
  body?: unknown;
}

/** The checks that need no credential: method, Origin, content type, configuration (D7 steps 1-4). */
function requestRefusal(req: http.IncomingMessage, auth: ResolvedRemoteMcpAuth | undefined): Refusal | undefined {
  if (req.method !== "POST") return { code: 405, reason: "method", detail: "the connector endpoint accepts POST only", headers: { Allow: "POST" } };
  const origin = header(req, "origin");
  if (origin && !auth?.allowedOrigins.has(origin)) return { code: 403, reason: "origin-refused", detail: `Origin ${origin} is not allowed` };
  if (!/^application\/json\b/i.test(header(req, "content-type") ?? "")) return { code: 415, reason: "content-type", detail: "Content-Type must be application/json" };
  if (!auth) return { code: 503, reason: "misconfigured", detail: "gateway.remoteMcp needs access.teamDomain, access.aud and allowedEmails" };
  return undefined;
}

function challenge(auth: ResolvedRemoteMcpAuth, invalid: boolean): Record<string, string> {
  const metadata = auth.resourceUrl ? `${new URL(auth.resourceUrl).origin}/.well-known/oauth-protected-resource/mcp` : undefined;
  const parts = [metadata ? `resource_metadata="${metadata}"` : undefined, invalid ? `error="invalid_token"` : undefined].filter(Boolean);
  return { "WWW-Authenticate": `Bearer${parts.length ? ` ${parts.join(", ")}` : ""}` };
}

/** The verified identity, or why it is refused (D7 steps 5-8). */
function identityRefusal(verified: AccessJwtResult, auth: ResolvedRemoteMcpAuth): Refusal | undefined {
  if (!verified.ok) {
    if (verified.reason === "misconfigured") return { code: 503, reason: "misconfigured", detail: verified.detail };
    return { code: 401, reason: verified.reason, detail: verified.detail, headers: challenge(auth, verified.reason !== "no-credential") };
  }
  if (auth.deniedEmails.has(verified.email)) return { code: 403, reason: "cut-off", detail: "this identity has been cut off", email: verified.email };
  if (!auth.allowedEmails.has(verified.email)) return { code: 403, reason: "not-allowed", detail: "this identity is not on the allow-list", email: verified.email };
  return undefined;
}

type RpcMessage = { id?: string | number | null; method?: string; params?: Record<string, unknown> };

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });

/** One JSON-RPC message, or the refusal for a body that is not one. */
function parseMessage(raw: string | undefined, email: string): { msg: RpcMessage } | { refusal: Refusal } {
  const refusal = (code: number, detail: string, body?: unknown): { refusal: Refusal } =>
    ({ refusal: { code, reason: "bad-request", detail, email, ...(body ? { body } : {}) } });
  if (raw === undefined) return refusal(413, "request body exceeds 1 MiB");
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return refusal(400, "body is not JSON", rpcError(-32700, "Parse error")); }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return refusal(400, "one JSON-RPC message per request", rpcError(-32600, "one JSON-RPC message per request"));
  }
  return { msg: message as RpcMessage };
}

/** What the log line says about the call: the client on `initialize`, the tool on `tools/call`. */
function callDetail(msg: RpcMessage): string {
  if (msg.method === "initialize") {
    const client = msg.params?.clientInfo as { name?: unknown; version?: unknown } | undefined;
    return ` client=${JSON.stringify(`${String(client?.name ?? "unknown")}/${String(client?.version ?? "?")}`)}`;
  }
  return msg.method === "tools/call" ? ` tool=${String(msg.params?.name)}` : "";
}

function negotiateVersion(msg: RpcMessage, response: Awaited<ReturnType<typeof handleMcpRequest>>): void {
  if (msg.method !== "initialize" || !response?.result || typeof response.result !== "object") return;
  const result = response.result as { protocolVersion?: string };
  if (!SUPPORTED_VERSIONS.includes(result.protocolVersion ?? "")) result.protocolVersion = SUPPORTED_VERSIONS[0];
}

/** `tool-not-in-profile` is its own outcome (FR-014): a caller probing for a tool the
 *  connector does not serve is worth seeing apart from a tool that ran and failed. */
function outcomeOf(response: Awaited<ReturnType<typeof handleMcpRequest>>, msg: RpcMessage, tools: JinnMcpTool[]): string {
  if (msg.method === "tools/call" && !tools.some((tool) => tool.name === msg.params?.name)) return "tool-not-in-profile";
  if (response?.error) return "rpc-error";
  return (response?.result as { isError?: boolean } | undefined)?.isError ? "tool-error" : "ok";
}

function prm(res: http.ServerResponse, config: JinnConfig): void {
  const resourceUrl = config.gateway.remoteMcp?.resourceUrl;
  if (!resourceUrl) return send(res, 404, { error: "Not found" });
  send(res, 200, { resource: resourceUrl, authorization_servers: [new URL(resourceUrl).origin], bearer_methods_supported: ["header"] });
}

interface HandlerState {
  deps: RemoteMcpHandlerDeps;
  status: RemoteMcpStatus;
  verifier?: { key: string; value: AccessJwtVerifier };
  /** Keyed by what the tool set depends on in config, so a hot-reloaded change takes effect. */
  tools: Map<string, JinnMcpTool[]>;
}

function verifierFor(state: HandlerState, auth: ResolvedRemoteMcpAuth): AccessJwtVerifier {
  const key = `${auth.teamDomain}|${auth.aud}`;
  if (state.verifier?.key !== key) {
    state.verifier = { key, value: state.deps.createVerifier?.(auth) ?? createAccessJwtVerifier({ teamDomain: auth.teamDomain, aud: auth.aud }) };
  }
  return state.verifier.value;
}

function record(state: HandlerState, outcome: string, refusal?: RemoteMcpReason): void {
  const at = new Date().toISOString();
  Object.assign(state.status, { lastRequestAt: at, lastOutcome: outcome }, refusal ? { lastRefusal: { at, reason: refusal } } : {});
}

function refuse(state: HandlerState, res: http.ServerResponse, refusal: Refusal): void {
  record(state, `refused:${refusal.reason}`, refusal.reason);
  const who = refusal.email ? ` email=${refusal.email}` : "";
  logger.info(`[remote-mcp] refused reason=${refusal.reason} status=${refusal.code}${who} detail=${JSON.stringify(refusal.detail)}`);
  send(res, refusal.code, refusal.body ?? { error: refusal.detail, reason: refusal.reason }, refusal.headers);
}

function toolsFor(state: HandlerState, config: JinnConfig): JinnMcpTool[] {
  const notesEnabled = config.gateway.notesEnabled === true;
  const knowledge = { guidance: config.knowledge?.guidance, missHint: config.knowledge?.missHint };
  const key = JSON.stringify([notesEnabled, knowledge.guidance ?? null, knowledge.missHint ?? null]);
  let tools = state.tools.get(key);
  if (!tools) {
    tools = buildRemoteMcpTools(notesEnabled, knowledge);
    state.tools.clear(); // only the current config's tool set is ever served
    state.tools.set(key, tools);
  }
  return tools;
}

/** One message, run as the identity's anchor session over loopback. */
async function run(state: HandlerState, msg: RpcMessage, email: string, config: JinnConfig) {
  const anchor = ensureRemoteMcpAnchor(email, config.engines.default);
  const response = await handleMcpRequest(msg, toolsFor(state, config), {
    gatewayUrl: loopbackUrl(config), token: state.deps.gatewayAuthToken, callerSessionId: anchor.id,
    sessionCapability: ensureSessionCapability(anchor.id), ...(state.deps.fetchFn ? { fetchFn: state.deps.fetchFn } : {}),
  });
  negotiateVersion(msg, response);
  return response;
}

async function handleMcp(state: HandlerState, req: http.IncomingMessage, res: http.ServerResponse, config: JinnConfig): Promise<void> {
  const started = Date.now();
  const auth = resolveRemoteMcpAuth(config.gateway.remoteMcp);
  const early = requestRefusal(req, auth);
  if (early || !auth) return refuse(state, res, early!);
  const verified = await verifierFor(state, auth).verify(header(req, "cf-access-jwt-assertion"));
  const denied = identityRefusal(verified, auth);
  if (denied || !verified.ok) return refuse(state, res, denied!);
  const parsed = parseMessage(await readBody(req), verified.email);
  if ("refusal" in parsed) return refuse(state, res, parsed.refusal);
  const { msg } = parsed;
  const response = await run(state, msg, verified.email, config);
  const outcome = outcomeOf(response, msg, toolsFor(state, config));
  record(state, outcome, outcome === "tool-not-in-profile" ? outcome : undefined);
  logger.info(`[remote-mcp] ${outcome} email=${verified.email} method=${String(msg.method)}${callDetail(msg)} ms=${Date.now() - started}`);
  return response ? send(res, 200, response) : send(res, 202, undefined);
}

export function createRemoteMcpHandler(deps: RemoteMcpHandlerDeps) {
  const state: HandlerState = { deps, status: { enabled: false, lastRequestAt: null, lastOutcome: null, lastRefusal: null }, tools: new Map() };
  return {
    /** `false` when the path is not the connector's; otherwise it has answered (or will, via the promise). */
    handle(req: http.IncomingMessage, res: http.ServerResponse): false | undefined | Promise<void> {
      const pathname = (req.url || "/").split("?")[0] ?? "/";
      if (pathname !== REMOTE_MCP_PATH && !PRM_PATHS.has(pathname)) return false;
      const config = deps.getConfig();
      if (config.gateway.remoteMcp?.enabled !== true) {
        send(res, 404, { error: "Not found" });
        return undefined;
      }
      if (PRM_PATHS.has(pathname)) {
        prm(res, config);
        return undefined;
      }
      return handleMcp(state, req, res, config).catch((err: unknown) => {
        logger.warn(`[remote-mcp] handler error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) send(res, 500, { error: "Internal error" });
      });
    },
    /** GET /api/remote-mcp (FR-015), served behind the gateway-token gate. */
    serveStatus(req: http.IncomingMessage, res: http.ServerResponse): boolean {
      if (req.method !== "GET" || (req.url || "/").split("?")[0] !== "/api/remote-mcp") return false;
      send(res, 200, { ...state.status, enabled: deps.getConfig().gateway.remoteMcp?.enabled === true });
      return true;
    },
  };
}

export type RemoteMcpHandler = ReturnType<typeof createRemoteMcpHandler>;
