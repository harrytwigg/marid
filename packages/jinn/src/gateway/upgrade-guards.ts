import type http from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { getSession } from "../sessions/registry.js";
import {
  originMatchesAuthority,
  parseAuthority,
  parseRequestAuthority,
  requestHeaderValues,
  type RequestAuthority,
  type RequestHeaders,
} from "./request-authority.js";
import { resolveCallerIdentity, type CallerIdentityOptions } from "./session-comm-guards.js";

/**
 * Who may open a WebSocket upgrade.
 *
 * The HTTP side of caller identity is enforced by the request handler; an
 * upgrade never reaches it, so these are the equivalent gate for a socket. Both
 * answer on the raw socket, because there is no ServerResponse to write to once
 * the connection is being upgraded.
 */

/** The little of a raw upgrade socket a rejection needs. */
export type UpgradeRejectionSocket = {
  write(chunk: string): unknown;
  destroy(): unknown;
};

function reject(socket: UpgradeRejectionSocket, error: string): true {
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    "\r\n" +
    JSON.stringify({ error }),
  );
  socket.destroy();
  return true;
}

export function rejectUnverifiedIdentifiedUpgradeCaller(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists"> = {},
): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: options.sessionExists ?? ((sessionId) => !!getSession(sessionId)),
    verifySessionCapability,
    requireCapability: true,
  });
  if (identity.kind !== "unidentified-tool") return false;
  return reject(socket, UNIDENTIFIED_TOOL_CALL_ERROR);
}

export function rejectNonOperatorPtyUpgradeCaller(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists" | "operatorAuthenticated"> = {},
): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: options.sessionExists ?? ((sessionId) => !!getSession(sessionId)),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated: options.operatorAuthenticated,
  });
  if (identity.kind === "operator") return false;
  return reject(
    socket,
    identity.kind === "unidentified-tool"
      ? UNIDENTIFIED_TOOL_CALL_ERROR
      : "/ws/pty is operator-only; capability-bound sessions cannot attach to or inject stdin into PTY sessions",
  );
}

/**
 * A browser may open a gateway socket only from the gateway's own origin. The
 * auth gate accepts the operator's cookie on its own, and SameSite=Lax does not
 * stop a sibling subdomain behind the same tunnel domain, so without this a page
 * there could ride the cookie. Every socket that answers to the cookie needs
 * it: `/ws/pty` types into a terminal's shell or an agent's TUI,
 * which runs with every permission; `/ws` and a plugin's event
 * socket stream session activity, titles and payloads.
 *
 * A browser always sends Origin on a WebSocket; a caller without one is not a
 * browser — the native shell's socket, an API client — and is left to the auth
 * gate. An Origin with a bearer token is still a browser, and is still checked.
 *
 * The origin the browser dialled is the request's Host, or the X-Forwarded-Host
 * a proxy that rewrote Host passed on; Chrome sends no fetch metadata on a
 * WebSocket, so nothing else in the request names it. A proxy that rewrites
 * Host and forwards neither is refused, as the HTTP API's origin check already
 * refuses it. The web package's Vite dev proxy forwards the host for
 * this reason.
 */
export function rejectCrossOriginUpgrade(
  req: RequestHeaders,
  socket: UpgradeRejectionSocket,
): boolean {
  const origins = requestHeaderValues(req, "origin");
  if (origins.length === 0) return false;
  const sameOrigin = origins.length === 1 && servedAuthorities(req).some((authority) =>
    originMatchesAuthority(origins[0], authority, { schemes: ["http:", "https:"] }));
  if (sameOrigin) return false;
  return reject(socket, "WebSocket upgrade refused: a browser may open a gateway socket only from the gateway's own origin");
}

/**
 * The whole gate for a `/ws/pty` upgrade: an operator caller, from the
 * gateway's own origin when it is a browser. It takes no session, so it holds
 * for every PTY view alike — agent CLI views as well as terminals.
 */
export function rejectPtyUpgrade(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists" | "operatorAuthenticated"> = {},
): boolean {
  return rejectNonOperatorPtyUpgradeCaller(req, socket, options)
    || rejectCrossOriginUpgrade(req, socket);
}

/** The authorities a request was addressed to: its Host, and the client-facing host a proxy forwarded. */
function servedAuthorities(req: RequestHeaders): RequestAuthority[] {
  const forwardedHost = requestHeaderValues(req, "x-forwarded-host")[0]?.split(",")[0]?.trim();
  return [parseRequestAuthority(req), parseAuthority(forwardedHost)]
    .filter((authority): authority is RequestAuthority => authority !== undefined);
}
