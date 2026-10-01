import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-root-fallback-"));
process.env.JINN_HOME = tmpHome;

const portalName = "Portal COO";
fs.writeFileSync(
  path.join(tmpHome, "config.yaml"),
  `gateway: {}
engines:
  default: codex
  claude: {}
portal:
  portalName: "${portalName}"
  setupComplete: true
`,
);

const orgDir = path.join(tmpHome, "org", "platform");
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, "department.yaml"), "name: platform\n");
fs.writeFileSync(
  path.join(orgDir, "platform-lead.yaml"),
  "name: platform-lead\ndisplayName: Platform Lead\ndepartment: platform\nrank: senior\nengine: codex\nmodel: gpt-5.5\npersona: Leads platform implementation.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-manager.yaml"),
  "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Executes platform work.\n",
);

type Api = typeof import("../api.js");
type Store = typeof import("../../work-items/store.js");
type Owner = typeof import("../work-item-owner.js");

let api: Api;
let store: Store;
let owner: Owner;

const apiCtx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" }, claude: {} },
    sessions: {},
    mcp: {},
    portal: { portalName },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

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
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

async function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../../work-items/store.js");
  await import("../../sessions/registry.js");
  owner = await import("../work-item-owner.js");
  (await import("../../shared/db.js")).initDb();
});

describe("org root resolution without an executive employee", () => {
  it("falls back to the configured portal as the COO/root", () => {
    expect(owner.resolveOrgRoot()).toEqual({ name: portalName, department: null, kind: "virtual" });
  });

  it("lets the operator read the portal-root needs-attention queue via me", async () => {
    const held = store.createWorkItem({ title: "operator inbox", source: "human", status: "blocked", assignee: portalName });

    const resp = await call("GET", "/api/work-items?needsAttentionFor=me&limit=10");

    expect(resp.status).toBe(200);
    expect(resp.body.workItems.map((item: { id: string }) => item.id)).toContain(held.id);
  });

  it("keeps an executive employee as the root when one exists", async () => {
    fs.writeFileSync(
      path.join(orgDir, "coo.yaml"),
      "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs the company.\n",
    );
    // Stands in for the org watcher: a YAML written behind the read owner's
    // back has to be announced before anyone can be expected to see it.
    const { refreshOrg } = await import("../org-registry.js");
    refreshOrg();

    expect(owner.resolveOrgRoot()).toEqual({ name: "coo", department: "platform", kind: "employee" });
  });
});
