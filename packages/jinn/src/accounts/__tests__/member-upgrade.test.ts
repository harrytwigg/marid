import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, type Joined } from "./flows-helpers.js";
import { routeMemberUpgrade } from "../member-upgrade.js";
import { MEMBER_SOCKET_CLOSE_UNAUTHORIZED } from "../member-sockets.js";

let h: Harness;
let pat: Joined;
let server: http.Server;
let port: number;
let operatorSawUpgrade: string[];
const memberWss = new WebSocketServer({ noServer: true });

beforeEach(async () => {
  h = await startHarness();
  pat = await inviteAndAccept(h, "pat@example.test");
  operatorSawUpgrade = [];
  // The same call server.ts makes first in its upgrade handler; what it declines goes on to the operator gate.
  server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    if (routeMemberUpgrade(req, socket, head, { accounts: h.rt, memberWss })) return;
    operatorSawUpgrade.push(req.url ?? "");
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterEach(async () => {
  for (const client of memberWss.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  h.close();
});

function connect(path: string, cookie: string): Promise<{ ws: WebSocket } | { status: number; body: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie } });
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on("error", () => { /* surfaced through unexpected-response */ });
  });
}

describe("a member's WebSocket upgrade", () => {
  it.each(["/ws/pty/x", "/ws/pty/some-session", "/api/plugins/demo/events", "/api/plugins/demo/events?since=1", "/ws?x=1", "/ws/", "/anything"])(
    "refuses %s with 403 before any other handler sees it", async (path) => {
      const result = await connect(path, pat.cookie);
      expect(result).toMatchObject({ status: 403 });
      expect(JSON.parse((result as { body: string }).body)).toEqual({ error: "Not available to board members" });
      expect(operatorSawUpgrade).toEqual([]);
    });

  it("accepts /ws, ties the socket to the session, and receives no broadcast frames", async () => {
    const result = await connect("/ws", pat.cookie);
    expect("ws" in result).toBe(true);
    const { ws } = result as { ws: WebSocket };
    const frames: string[] = [];
    ws.on("message", (raw) => frames.push(raw.toString()));
    ws.send(JSON.stringify({ event: "ping" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toEqual([JSON.stringify({ event: "pong", payload: {} })]);
    expect(h.rt.memberSockets.size()).toBe(1);
    ws.close();
  });

  it.each([
    ["the user is disabled", (id: string) => h.asOperator("PATCH", `/api/people/${id}`, { status: "disabled" })],
    ["all sessions are revoked", (id: string) => h.asOperator("DELETE", `/api/people/${id}/sessions`)],
    ["the user is deleted", (id: string) => h.asOperator("DELETE", `/api/people/${id}`)],
  ])("closes the socket 4401 when %s", async (_name, act) => {
    const { ws } = (await connect("/ws", pat.cookie)) as { ws: WebSocket };
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await act(pat.userId);
    expect(await closed).toBe(MEMBER_SOCKET_CLOSE_UNAUTHORIZED);
  });

  it("closes the socket 4401 when a reload turns gateway auth off, and ignores the cookie after", async () => {
    const { ws } = (await connect("/ws", pat.cookie)) as { ws: WebSocket };
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    h.config.gateway = { host: "127.0.0.1", authRequired: false };
    expect(h.rt.memberSockets.closeAll()).toBe(1); // what the config reload does
    expect(await closed).toBe(MEMBER_SOCKET_CLOSE_UNAUTHORIZED);
    const again = await connect("/ws", pat.cookie);
    expect(operatorSawUpgrade).toEqual(["/ws"]); // no longer a member: falls to the operator gate
    expect(again).toMatchObject({ status: 401 });
  });

  it("the sweep closes a socket whose session expired", async () => {
    const { ws } = (await connect("/ws", pat.cookie)) as { ws: WebSocket };
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    h.clock.now += 31 * 24 * 60 * 60 * 1000 + 1000;
    h.db.prepare("UPDATE user_sessions SET expires_at = ? WHERE user_id = ?").run(new Date(h.clock.now - 1000).toISOString(), pat.userId);
    h.rt.memberSockets.sweep();
    expect(await closed).toBe(MEMBER_SOCKET_CLOSE_UNAUTHORIZED);
  });

  it("an operator cookie and a request without one are not touched by the member branch", async () => {
    const op = await connect("/ws", "");
    expect(op).toMatchObject({ status: 401 });
    expect(operatorSawUpgrade).toEqual(["/ws"]);
  });
});
