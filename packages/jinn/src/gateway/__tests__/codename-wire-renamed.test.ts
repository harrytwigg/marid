import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import type { IncomingMessage } from "node:http";
import {
  AUTH_COOKIE,
  authCookieName,
  authDeviceCookieName,
  authenticateGatewayRequest,
  clearAuthCookieHeaders,
  createAuthSession,
  currentAuthDeviceId,
  legacyAuthCookieMigration,
} from "../auth.js";
import { CONFIG_REVISION_RESPONSE_HEADERS, isStaleConfigRevision, setConfigRevisionHeaders } from "../config-revision.js";
import { CORS_ALLOWED_REQUEST_HEADERS, CORS_EXPOSED_RESPONSE_HEADERS, createGatewayRequestHandler } from "../request-handler.js";
import { handleHookPost } from "../hook-endpoint.js";
import { HookRegistry } from "../hook-registry.js";
import { resolveCallerIdentity } from "../session-comm-guards.js";
import { WRITE_ORIGIN_HEADER, readWriteOrigin } from "../../work-items/origin.js";
import { CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";
import { isToolCallMarker } from "../../shared/wire-names.js";

type Headers = Record<string, string | string[] | undefined>;
const request = (headers: Headers, remote = "100.64.1.2"): Pick<IncomingMessage, "headers" | "socket"> =>
  ({ headers, socket: { remoteAddress: remote } }) as unknown as Pick<IncomingMessage, "headers" | "socket">;

describe("what an upgraded gateway writes", () => {
  it("names its headers, marker and cookies after the current codename", () => {
    expect(CALLER_SESSION_HEADER).toBe("x-acme-caller-session");
    expect(TOOL_CALL_HEADER).toBe("x-acme-tool-call");
    expect(TOOL_CALL_HEADER_VALUE).toBe("acme-mcp");
    expect(WRITE_ORIGIN_HEADER).toBe("x-acme-origin");
    expect(AUTH_COOKIE).toBe("acme_auth");
  });

  it("lets a browser on either build read the config revision, and be sent both in the CORS lists", () => {
    const sent: Record<string, string> = {};
    setConfigRevisionHeaders({ setHeader: (name, value) => { sent[name] = value; } }, "rev1");
    expect(sent).toEqual({ "X-Acme-Config-Revision": "rev1", "X-Jinn-Config-Revision": "rev1" });
    expect(CONFIG_REVISION_RESPONSE_HEADERS).toEqual(["X-Acme-Config-Revision", "X-Jinn-Config-Revision"]);
    for (const name of ["X-Acme-Bootstrap-Grant", "X-Jinn-Bootstrap-Grant", "X-Acme-Config-Revision", "X-Jinn-Config-Revision"]) {
      expect(CORS_ALLOWED_REQUEST_HEADERS).toContain(name);
    }
    expect(CORS_EXPOSED_RESPONSE_HEADERS).toBe("X-Acme-Config-Revision, X-Jinn-Config-Revision");
  });
});

describe("what an upgraded gateway accepts from a peer that has not upgraded", () => {
  const noop = () => undefined;
  const handlerFor = () => createGatewayRequestHandler({
    authRequired: () => false,
    gatewayAuthToken: "t",
    home: os.tmpdir(),
    apiContext: {} as never,
    webDir: os.tmpdir(),
    remoteMcp: { handle: () => false, serveStatus: () => false } as never,
  });

  it("gives every legacy-named request header its current name before any route reads it", () => {
    const headers: Headers = {
      "x-jinn-caller-session": "sess-1",
      "x-jinn-session-capability": "cap",
      "x-jinn-tool-call": "jinn-mcp",
      "x-jinn-origin": "talk",
      "x-jinn-config-revision": "rev1",
      origin: undefined,
    };
    const res = { setHeader: noop, writeHead: noop, end: noop } as never;
    void handlerFor()({ url: "/", method: "OPTIONS", headers } as never, res);
    expect(headers[CALLER_SESSION_HEADER]).toBe("sess-1");
    expect(readWriteOrigin(headers[WRITE_ORIGIN_HEADER])).toBe("talk");
    expect(isStaleConfigRevision(headers, "rev1")).toBe(false);
    expect(isStaleConfigRevision(headers, "rev2")).toBe(true);
    const identity = resolveCallerIdentity(headers, { sessionExists: () => true, requireCapability: true, verifySessionCapability: (id, cap) => id === "sess-1" && cap === "cap" });
    expect(identity).toEqual({ kind: "session", callerId: "sess-1" });
  });

  it("recognises an older MCP server's tool-call marker", () => {
    expect(isToolCallMarker("jinn-mcp")).toBe(true);
    expect(isToolCallMarker("acme-mcp")).toBe(true);
  });

  it("takes a hook post from a relay that names the session under the old field", () => {
    const reg = new HookRegistry();
    try {
      const delivered: string[] = [];
      reg.register("s1", (hook) => { delivered.push(hook.hook_event_name); });
      const legacy = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" }, "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
      const current = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" }, "sek", { acmeSessionId: "s1", hook: { hook_event_name: "Stop" } });
      const neither = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" }, "sek", { hook: { hook_event_name: "Stop" } });
      expect([legacy.status, current.status, neither.status]).toEqual([200, 200, 400]);
      expect(delivered).toEqual(["Stop", "Stop"]);
    } finally {
      reg.dispose();
    }
  });
});

describe("a browser paired before the rename", () => {
  let home: string;
  // The old build derived the cookie namespace from its own name for the same instance: `acme-x` was `jinn-x`.
  let legacyNs: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "acme-auth-"));
    legacyNs = path.basename(home).replace(/^acme-/, "jinn-");
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("stays signed in on the old cookie names and is moved onto the new ones", () => {
    const session = createAuthSession(home, request({ "user-agent": "Mozilla/5.0" }));
    expect(authCookieName(home)).toMatch(/^acme_auth_/);
    const legacy = `jinn_auth_${legacyNs}=${session.secret}; jinn_device_${legacyNs}=${session.device.id}`;
    expect(authenticateGatewayRequest(request({ cookie: legacy }), "tok", home).ok).toBe(true);
    expect(currentAuthDeviceId({ cookie: legacy }, home)).toBe(session.device.id);

    const migrated = legacyAuthCookieMigration({ cookie: legacy }, home, true);
    expect(migrated).toHaveLength(4);
    expect(migrated[0]).toMatch(new RegExp(`^${authCookieName(home)}=${session.secret};.*Secure`));
    expect(migrated[1]).toMatch(new RegExp(`^${authDeviceCookieName(home)}=${session.device.id};`));
    expect(migrated.slice(2).every((header) => header.includes("Max-Age=0"))).toBe(true);
  });

  it("is left alone once it carries the new names, and signed out with a wrong secret on either", () => {
    const session = createAuthSession(home, request({}));
    const current = `${authCookieName(home)}=${session.secret}; ${authDeviceCookieName(home)}=${session.device.id}`;
    expect(authenticateGatewayRequest(request({ cookie: current }), "tok", home).ok).toBe(true);
    expect(legacyAuthCookieMigration({ cookie: current }, home)).toEqual([]);
    const wrong = `jinn_auth_${legacyNs}=nope; jinn_device_${legacyNs}=${session.device.id}`;
    expect(authenticateGatewayRequest(request({ cookie: wrong }), "tok", home).ok).toBe(false);
  });

  it("clears the cookies of both builds on sign-out", () => {
    const cleared = clearAuthCookieHeaders(home).map((header) => header.split("=")[0]);
    expect(cleared).toContain(authCookieName(home));
    expect(cleared).toContain(`jinn_auth_${legacyNs}`);
    expect(cleared).toContain(`jinn_device_${legacyNs}`);
  });
});
