import { readFileSync } from "node:fs";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { rejectCrossOriginUpgrade, rejectPtyUpgrade } from "../upgrade-guards.js";

// A /ws/pty socket types into a terminal's shell or an agent's TUI: a browser
// may open one only from the gateway's own origin, whatever cookie it carries.

function attempt(headers: Record<string, string>) {
  const written: string[] = [];
  let destroyed = false;
  const refused = rejectCrossOriginUpgrade({ headers }, {
    write: (chunk: string) => { written.push(chunk); },
    destroy: () => { destroyed = true; },
  });
  return { refused, destroyed, written: written.join("") };
}

describe("rejectCrossOriginUpgrade", () => {
  it("admits the gateway's own origin, direct or behind a proxy that forwards the host", () => {
    expect(attempt({ host: "127.0.0.1:7801", origin: "http://127.0.0.1:7801" }).refused).toBe(false);
    expect(attempt({ host: "jinn.example.com", origin: "https://jinn.example.com" }).refused).toBe(false);
    expect(attempt({ host: "127.0.0.1:7801", "x-forwarded-host": "jinn.example.com", origin: "https://jinn.example.com" }).refused).toBe(false);
  });

  it("refuses a sibling subdomain or any other origin with a 403", () => {
    const sibling = attempt({ host: "jinn.example.com", origin: "https://blog.example.com" });
    expect(sibling).toMatchObject({ refused: true, destroyed: true });
    expect(sibling.written).toMatch(/^HTTP\/1\.1 403/);
    expect(attempt({ host: "127.0.0.1:7801", origin: "http://127.0.0.1:8080" }).refused).toBe(true);
    expect(attempt({ host: "127.0.0.1:7801", origin: "null" }).refused).toBe(true);
  });

  it("leaves a caller with no Origin (not a browser) to the token gate", () => {
    expect(attempt({ host: "127.0.0.1:7801" }).refused).toBe(false);
  });
});

// a proxy that rewrites Host must pass the dialled host on in
// X-Forwarded-Host. Chrome sends no fetch metadata on a WebSocket, so without
// it nothing in the request tells a same-origin page from a sibling.
describe("rejectCrossOriginUpgrade behind a Host-rewriting proxy", () => {
  it("admits the web app through the Vite dev proxy, which forwards the dialled host", () => {
    expect(attempt({ host: "127.0.0.1:7801", "x-forwarded-host": "localhost:5173", origin: "http://localhost:5173" }).refused).toBe(false);
  });

  it("admits the web app behind a TLS proxy that rewrites Host and forwards the public host", () => {
    expect(attempt({ host: "localhost:7801", "x-forwarded-host": "jinn.example.com", origin: "https://jinn.example.com" }).refused).toBe(false);
    expect(attempt({ host: "localhost:7801", "x-forwarded-host": "jinn.example.com:443", origin: "https://jinn.example.com" }).refused).toBe(false);
  });

  it("refuses a sibling subdomain or another local port behind that proxy", () => {
    const sibling = attempt({ host: "localhost:7801", "x-forwarded-host": "jinn.example.com", origin: "https://blog.example.com" });
    expect(sibling).toMatchObject({ refused: true, destroyed: true });
    expect(sibling.written).toMatch(/^HTTP\/1\.1 403/);
    expect(attempt({ host: "127.0.0.1:7801", "x-forwarded-host": "localhost:5173", origin: "http://localhost:3000" }).refused).toBe(true);
  });

  it("refuses a proxy that rewrites Host and forwards nothing, sibling or not", () => {
    // Both look identical to the gateway; the HTTP API's origin check refuses
    // this proxy shape too.
    expect(attempt({ host: "127.0.0.1:7801", origin: "http://localhost:5173" }).refused).toBe(true);
    expect(attempt({ host: "localhost:7801", origin: "https://jinn.example.com" }).refused).toBe(true);
    expect(attempt({ host: "localhost:7801", origin: "https://blog.example.com" }).refused).toBe(true);
  });

  it("matches Origin against Host by the scheme's default port, not as a string", () => {
    expect(attempt({ host: "jinn.example.com:443", origin: "https://jinn.example.com" }).refused).toBe(false);
    expect(attempt({ host: "JINN.example.com", origin: "https://jinn.example.com" }).refused).toBe(false);
    expect(attempt({ host: "jinn.example.com", origin: "https://jinn.example.com:8443" }).refused).toBe(true);
    expect(attempt({ host: "jinn.example.com:80", origin: "https://jinn.example.com" }).refused).toBe(true);
  });

  it("reads the client-facing host from a multi-hop X-Forwarded-Host", () => {
    expect(attempt({ host: "127.0.0.1:7801", "x-forwarded-host": "jinn.example.com, 10.0.0.2:8080", origin: "https://jinn.example.com" }).refused).toBe(false);
    expect(attempt({ host: "127.0.0.1:7801", "x-forwarded-host": "10.0.0.2:8080, jinn.example.com", origin: "https://jinn.example.com" }).refused).toBe(true);
  });

  it("refuses an Origin no page would send, even when Host matches", () => {
    for (const origin of ["", "null", "ws://127.0.0.1:7801", "http://user:pw@127.0.0.1:7801", "chrome-extension://abc"]) {
      expect(attempt({ host: "127.0.0.1:7801", origin }).refused, origin).toBe(true);
    }
  });
});

// the origin check covered terminals only, so an agent's CLI view —
// a TUI running with every permission — opened from a sibling subdomain on the
// cookie alone. The PTY gate now takes no session at all.
describe("rejectPtyUpgrade, the gate for every /ws/pty upgrade", () => {
  function upgrade(headers: Record<string, string>, operatorAuthenticated: boolean) {
    const written: string[] = [];
    let destroyed = false;
    const rawHeaders = Object.entries(headers).flat();
    const refused = rejectPtyUpgrade({ headers, rawHeaders } as unknown as http.IncomingMessage, {
      write: (chunk: string) => { written.push(chunk); },
      destroy: () => { destroyed = true; },
    }, { operatorAuthenticated, sessionExists: () => false });
    return { refused, destroyed, written: written.join("") };
  }

  it("refuses the operator's cookie from a sibling subdomain", () => {
    const sibling = upgrade({ host: "jinn.example.com", origin: "https://blog.example.com" }, true);
    expect(sibling).toMatchObject({ refused: true, destroyed: true });
    expect(sibling.written).toMatch(/^HTTP\/1\.1 403/);
    expect(sibling.written).toContain("gateway's own origin");
  });

  it("admits the operator from the gateway's own origin", () => {
    expect(upgrade({ host: "jinn.example.com", origin: "https://jinn.example.com" }, true).refused).toBe(false);
    expect(upgrade({ host: "127.0.0.1:7801", "x-forwarded-host": "localhost:5173", origin: "http://localhost:5173" }, true).refused).toBe(false);
  });

  it("admits an authenticated caller with no Origin: a bearer-token client or the native shell", () => {
    expect(upgrade({ host: "127.0.0.1:7801", authorization: "Bearer t" }, true).refused).toBe(false);
  });

  it("refuses a bearer token that arrives with a foreign Origin: an Origin means a browser", () => {
    expect(upgrade({ host: "jinn.example.com", authorization: "Bearer t", origin: "https://blog.example.com" }, true).refused).toBe(true);
  });

  it("still refuses an unauthenticated caller, Origin or not, with one 403", () => {
    for (const headers of [{ host: "127.0.0.1:7801" }, { host: "127.0.0.1:7801", origin: "http://127.0.0.1:7801" }] as Record<string, string>[]) {
      const result = upgrade(headers, false);
      expect(result).toMatchObject({ refused: true, destroyed: true });
      expect(result.written.match(/HTTP\/1\.1 403/g)).toHaveLength(1);
      expect(result.written).toContain("operator-only");
    }
  });

  it("is the whole gate in server.ts, run before the session is looked up", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const branch = source.slice(source.indexOf("const ptyMatch"), source.indexOf("ptyWss.handleUpgrade("));
    expect(branch).toMatch(/\bif \(rejectPtyUpgrade\(req, socket,/);
    expect(branch.indexOf("rejectPtyUpgrade(")).toBeLessThan(branch.indexOf("getSession("));
    // The pty branch takes its two halves only through rejectPtyUpgrade; the
    // origin half alone guards the event sockets, not this branch.
    expect(branch).not.toMatch(/rejectCrossOriginUpgrade/);
    expect(source).not.toMatch(/rejectNonOperatorPtyUpgradeCaller/);
  });
});

// `/ws` and a plugin's event socket stream session activity, titles
// and payloads, and accepted the operator's cookie from a sibling subdomain.
// They take the same origin check, after the auth gate and before the upgrade.
describe("rejectCrossOriginUpgrade on the event sockets", () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

  it("guards the /ws broadcast before it upgrades", () => {
    const branch = source.slice(source.indexOf('if (reqUrl === "/ws")'), source.indexOf("wss.emit(\"connection\""));
    expect(branch).toMatch(/\bif \(rejectCrossOriginUpgrade\(req, socket\)\) return;/);
    expect(branch.indexOf("rejectCrossOriginUpgrade(")).toBeLessThan(branch.indexOf("wss.handleUpgrade("));
  });

  it("guards a plugin's event socket before it upgrades", () => {
    const branch = source.slice(source.indexOf("if (pluginEventsId)"), source.indexOf("const ptyMatch"));
    expect(branch).toMatch(/\bif \(rejectCrossOriginUpgrade\(req, socket\)\) return;/);
    expect(branch.indexOf("rejectCrossOriginUpgrade(")).toBeLessThan(branch.indexOf("pluginEvents.handleUpgrade("));
  });

  it("runs after the auth gate, so an anonymous caller still gets a 401", () => {
    const gate = source.indexOf("authenticateGatewayRequest(req, gatewayAuthToken, JINN_HOME)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(source.indexOf("rejectCrossOriginUpgrade(req, socket)"));
  });

  it("names no single path in its refusal, now that three paths share it", () => {
    const written: string[] = [];
    rejectCrossOriginUpgrade({ headers: { host: "jinn.example.com", origin: "https://blog.example.com" } }, {
      write: (chunk: string) => { written.push(chunk); },
      destroy: () => {},
    });
    expect(written.join("")).toContain("gateway's own origin");
    expect(written.join("")).not.toMatch(/pty/i);
  });
});
