import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { JinnConfig, McpGlobalConfig } from "../../shared/types.js";
import { refreshOrg } from "../org-registry.js";

/** Drives the real API handler as the operator, for the department route suites. */

type Api = typeof import("../api.js");
let api: Api;

export async function loadApi(): Promise<void> {
  api = await import("../api.js");
}

let orgReloads = 0;

/** How many times a handler has asked the gateway to reload the org since the last call. */
export function takeOrgReloads(): number {
  const count = orgReloads;
  orgReloads = 0;
  return count;
}

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
  models: { claude: { default: "sonnet", models: [{ id: "sonnet", supportsEffort: false }] } },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as JinnConfig;

/** What the instance configures under `mcp:`; the default is the built-in gateway server alone. */
export function setInstanceMcp(mcp: McpGlobalConfig | undefined): void {
  config.mcp = mcp;
}

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {
    orgReloads++;
    refreshOrg(config);
  },
  sessionManager: { getEngine: () => undefined, getEngines: () => new Map() },
} as unknown as import("../api.js").ApiContext;

function capture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) {
      status = next;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

export async function call(method: string, url: string, body?: unknown) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" },
  });
  const out = capture();
  await api.handleApiRequest(request as unknown as Parameters<Api["handleApiRequest"]>[0], out.res, context);
  return { status: out.status, body: out.body };
}

