import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * In-process gateway harness for MCP work-item suites: the real API module is
 * passed in (each suite imports it only after pointing JINN_HOME at a temp dir),
 * so this module has no runtime gateway imports of its own.
 */

type Api = typeof import("../../../gateway/api.js");

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", engineStub]]),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../../../gateway/api.js").ApiContext;

/** A fetch that drives the real gateway API in-process — including multipart
 *  bodies, serialized exactly as fetch would send them. */
export function inProcessGatewayFetch(api: Api): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    let body: Buffer[] = [];
    if (typeof init?.body === "string") body = [Buffer.from(init.body)];
    else if (init?.body instanceof FormData) {
      // Serialize multipart exactly as fetch would, boundary header included.
      const encoded = new Request(url, { method: "POST", body: init.body });
      body = [Buffer.from(await encoded.arrayBuffer())];
      headers["content-type"] = encoded.headers.get("content-type")!;
    }
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** The platform/other org the work-item suites act as. */
export function seedPlatformOrg(home: string): void {
  const dir = path.join(home, "org", "platform");
  const otherDir = path.join(home, "org", "other");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "department.yaml"), "name: platform\n");
  fs.writeFileSync(path.join(otherDir, "department.yaml"), "name: other\n");
  fs.writeFileSync(
    path.join(dir, "coo.yaml"),
    "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs operations.\n",
  );
  fs.writeFileSync(
    path.join(dir, "platform-manager.yaml"),
    "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform.\nreportsTo: coo\n",
  );
  fs.writeFileSync(
    path.join(dir, "platform-dev.yaml"),
    "name: platform-dev\ndisplayName: Platform Dev\ndepartment: platform\nrank: senior\nengine: codex\nmodel: gpt-5.5\npersona: Builds the platform.\nreportsTo: platform-manager\n",
  );
  fs.writeFileSync(
    path.join(otherDir, "outsider.yaml"),
    "name: outsider\ndisplayName: Outsider\ndepartment: other\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Works elsewhere.\nreportsTo: coo\n",
  );
}
