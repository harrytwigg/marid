import http from "node:http";
import { EventEmitter } from "node:events";
import { AddressInfo } from "node:net";

/** Fakes and fixtures shared by the cross-stream isolation and
 *  pooled recovery suites. Both drive the proxy's upstream seam, one with a real local
 *  server and one with stubs, so the pieces live here rather than in either. */

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Upstream {
  port: number;
  attempts: () => number;
  /** Client-side port per attempt, so a test can tell socket reuse from a new one. */
  sockets: () => number[];
  close: () => Promise<void>;
}

/** A local plaintext stand-in for api.anthropic.com. `onAttempt` decides what
 *  each arriving upstream request does — answer, hold, or drop its socket. */
export function startUpstream(
  onAttempt: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Upstream> {
  let n = 0;
  const sockets: number[] = [];
  const server = http.createServer((req, res) => {
    n += 1;
    sockets.push(req.socket.remotePort ?? -1);
    req.resume();
    onAttempt(n, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        attempts: () => n,
        sockets: () => sockets,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

/** One client turn through the proxy, resolved once the body is fully read. */
export function callProxy(
  port: number,
  opts: { agent?: http.Agent | false; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        agent: opts.agent ?? false, headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

export const STARVED = { status: -1, body: "STARVED" };

/** Resolve to STARVED instead of hanging, so a starved stream fails with a
 *  readable assertion rather than a suite timeout. */
export const withDeadline = (p: Promise<{ status: number; body: string }>, ms: number) =>
  Promise.race([p, wait(ms).then(() => STARVED)]);

/** A ClientRequest-like stub. The proxy only writes the body, ends the request,
 *  arms an idle timeout, destroys it and listens for 'error', so an emitter with
 *  those members stands in for a socket-backed one. `onEnd` fires once the proxy
 *  has sent the request; `onDestroy` when it destroys it — which, on a real
 *  keep-alive request, takes the socket underneath down with it. */
export function fakeUpstreamRequest(
  hooks: { onEnd: () => void; onDestroy?: () => void },
): http.ClientRequest {
  const request = new EventEmitter() as EventEmitter & Record<string, unknown>;
  request.write = () => true;
  request.setTimeout = () => request;
  request.destroy = () => hooks.onDestroy?.();
  request.end = () => hooks.onEnd();
  return request as unknown as http.ClientRequest;
}

/** An IncomingMessage-like stub: emit 'data'/'end'/'error' on it to drive the
 *  upstream response the proxy streams back to its client. */
export function fakeUpstreamResponse(headers: Record<string, string>): http.IncomingMessage {
  const response = new EventEmitter() as unknown as http.IncomingMessage;
  Object.assign(response, { statusCode: 200, headers, pause: () => {}, resume: () => {} });
  return response;
}
