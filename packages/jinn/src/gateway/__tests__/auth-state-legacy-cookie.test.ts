import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import { handleApiRequest, type ApiContext } from "../api.js";
import { authCookieName, authDeviceCookieName, createAuthSession } from "../auth.js";
import { enforceOwnerOnlyDirectory } from "../../shared/owner-only.js";

/** A browser paired by a build before the codename changed, asking a renamed build who it is. The route is the
 *  one that moves its cookies onto the new names; what a unit of the cookie helpers proves is not that it runs. */
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "auth-state-")));
  enforceOwnerOnlyDirectory(root);
  vi.spyOn(os, "homedir").mockReturnValue(root);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function stateRequest(home: string, cookie: string): { setCookie: unknown; body: { authenticated?: boolean } } {
  const req = Readable.from([]) as IncomingMessage;
  req.method = "GET";
  req.url = "/api/auth/state";
  req.headers = { host: "localhost", cookie };
  (req as unknown as { socket: object }).socket = { remoteAddress: "127.0.0.1" };
  let setCookie: unknown;
  const chunks: Buffer[] = [];
  const res = {
    setHeader(name: string, value: unknown) { if (name.toLowerCase() === "set-cookie") setCookie = value; return this; },
    writeHead() { return this; },
    end(buffer?: Buffer | string) { if (buffer) chunks.push(Buffer.from(buffer)); return this; },
  } as unknown as ServerResponse;
  const context = { gatewayAuthToken: "gateway-token", jinnHome: home, getConfig: () => ({ gateway: { host: "0.0.0.0" }, engines: { default: "claude" } }), connectors: new Map(), startTime: Date.now() } as unknown as ApiContext;
  return handleApiRequest(req, res, context).then(() => ({ setCookie, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) })) as never;
}

const pair = (home: string) => createAuthSession(home, { headers: { "user-agent": "Mozilla/5.0" }, socket: { remoteAddress: "127.0.0.1" } } as never, { kind: "local" });

describe("GET /api/auth/state for a browser paired before the rename", () => {
  it("keeps a browser of the default home that is still at its old path signed in, and moves its cookies to the new names", async () => {
    const home = path.join(root, ".jinn");
    fs.mkdirSync(home);
    enforceOwnerOnlyDirectory(home);
    const session = pair(home);
    // Under the old build the default home had the bare names, and the renamed build keeps bare names for it.
    expect(authCookieName(home)).toBe("acme_auth");
    const answered = await stateRequest(home, `jinn_auth=${session.secret}; jinn_device=${session.device.id}`);
    expect(answered.body.authenticated).toBe(true);
    const headers = answered.setCookie as string[];
    expect(headers).toHaveLength(4);
    expect(headers[0]).toMatch(new RegExp(`^acme_auth=${session.secret};`));
    expect(headers[1]).toMatch(new RegExp(`^acme_device=${session.device.id};`));
    expect(headers.slice(2)).toEqual([expect.stringMatching(/^jinn_auth=; .*Max-Age=0/), expect.stringMatching(/^jinn_device=; .*Max-Age=0/)]);
  });

  it("does the same for a named instance, by its old and new namespaces", async () => {
    const home = path.join(root, ".acme-john");
    fs.mkdirSync(home);
    enforceOwnerOnlyDirectory(home);
    const session = pair(home);
    const answered = await stateRequest(home, `jinn_auth_jinn-john=${session.secret}; jinn_device_jinn-john=${session.device.id}`);
    expect(answered.body.authenticated).toBe(true);
    expect((answered.setCookie as string[])[0]).toMatch(new RegExp(`^${authCookieName(home)}=${session.secret};`));
    expect((answered.setCookie as string[])[1]).toMatch(new RegExp(`^${authDeviceCookieName(home)}=`));
  });

  it("sets nothing for a browser already on the new names", async () => {
    const home = path.join(root, ".acme-john");
    fs.mkdirSync(home);
    enforceOwnerOnlyDirectory(home);
    const session = pair(home);
    const answered = await stateRequest(home, `${authCookieName(home)}=${session.secret}; ${authDeviceCookieName(home)}=${session.device.id}`);
    expect(answered.body.authenticated).toBe(true);
    expect(answered.setCookie).toBeUndefined();
  });
});
