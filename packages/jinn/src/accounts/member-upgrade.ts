import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { rejectCrossOriginUpgrade } from "../gateway/upgrade-guards.js";
import { trackHeartbeat } from "../gateway/ws-heartbeat.js";
import { requestUserToken } from "./cookie.js";
import { memberMayUpgrade, NOT_AVAILABLE_TO_MEMBERS } from "./member-router.js";
import type { AccountsRuntime, MemberPrincipal } from "./runtime.js";

function refuse(socket: Duplex, status: string, error: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error })}`);
  socket.destroy();
}

/**
 * A member's WebSocket upgrade. Only `/ws` is open to them (not `/ws/pty/*`, not a plugin's event stream),
 * from the gateway's own origin; everything else is refused 403 before any other handler sees the socket.
 * The accepted socket is tied to the member's session and closed 4401 when that session stops being valid.
 * It is not in the general broadcast's client set, so it receives none of its frames.
 */
function handleMemberUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  principal: MemberPrincipal,
  deps: { accounts: AccountsRuntime; memberWss: WebSocketServer },
): void {
  if (!memberMayUpgrade(req.url || "")) return refuse(socket, "403 Forbidden", NOT_AVAILABLE_TO_MEMBERS);
  if (rejectCrossOriginUpgrade(req, socket)) return;
  deps.memberWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    trackHeartbeat(ws);
    deps.accounts.memberSockets.add(ws, principal.sessionId);
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.event === "ping" && ws.readyState === 1) ws.send(JSON.stringify({ event: "pong", payload: {} }));
      } catch { /* ignore non-JSON frames */ }
    });
    ws.on("close", () => deps.accounts.memberSockets.remove(ws));
    ws.on("error", () => deps.accounts.memberSockets.remove(ws));
  });
}

/**
 * The member branch of the server's upgrade handler: resolves who is asking with the same `resolvePrincipal`
 * the HTTP handler uses and, for a member, answers the upgrade. True when it did (the caller returns); false
 * for everyone else, who go on to the operator gate untouched. A request with no member cookie costs nothing.
 */
export function routeMemberUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: { accounts: AccountsRuntime; memberWss: WebSocketServer },
): boolean {
  if (!requestUserToken(req.headers, deps.accounts.home)) return false;
  const principal = deps.accounts.resolvePrincipal(req);
  if (principal.kind !== "member") return false;
  handleMemberUpgrade(req, socket, head, principal, deps);
  return true;
}

/** Re-check every member socket's session on a timer, for expiry and for changes made outside the API. */
export function startMemberSocketSweep(accounts: AccountsRuntime, intervalMs = 30_000): () => void {
  const timer = setInterval(() => accounts.memberSockets.sweep(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
