import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../../mcp/identity.js";

/**
 * Shared fixture for the work-item attachment route suites. They drive
 * handleApiRequest directly with fake req/res — no HTTP server boot — and point
 * the registry DB at a throwaway JINN_HOME so they never touch the live DB.
 *
 * Unlike the generic work-items harness, the capture here keeps response
 * headers and the raw bytes: ranged downloads, variant caching, and
 * Content-Disposition all assert on them.
 *
 * The pool is `forks`, so importing this gives each suite its own process, its
 * own home, and its own SQLite DB. JINN_HOME must be set before db.js loads;
 * keep that order.
 */

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-att-route-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Route-test worker.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "solo-worker.yaml"),
  "name: solo-worker\ndisplayName: Solo Worker\ndepartment: marketing\nrank: employee\nengine: codex\nmodel: default\npersona: Route-test loner.\n",
);

export const api = await import("../../api.js");
export const reg = await import("../../../sessions/registry.js");
export const store = await import("../../../work-items/store.js");
export const comments = await import("../../../work-items/comments.js");
export const attachments = await import("../../../work-items/attachments.js");
(await import("../../../shared/db.js")).initDb();

export type ApiRequest = Parameters<typeof api.handleApiRequest>[0];

export function makeRes() {
  let status = 200;
  let headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const res = new class extends Writable {
    override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    }

    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      if (h) headers = { ...headers, ...h };
      return this;
    }

    setHeader(name: string, value: unknown) {
      headers[name] = value;
      return this;
    }
  }() as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get raw() {
      return Buffer.concat(chunks);
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

export function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as ApiRequest;
}

export function makeMultipartReq(
  urlPath: string,
  parts: { file?: { name: string; content: Buffer }; fields?: Record<string, string> },
  headers: Record<string, string> = {},
) {
  const boundary = "----jinnAttachmentBoundary";
  const segments: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    segments.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (parts.file) {
    segments.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${parts.file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    segments.push(parts.file.content, Buffer.from("\r\n"));
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(segments);
  return Object.assign(Readable.from([body]), {
    method: "POST",
    url: urlPath,
    headers: {
      host: "localhost",
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
      ...headers,
    },
  }) as unknown as ApiRequest;
}

export const emittedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

export const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emittedEvents.push({ event, payload }),
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../../api.js").ApiContext;

/** Bearer credentials for the operator surface. */
export const operatorHeaders = { authorization: "Bearer test-token" };

/** Capability headers that identify a caller as a specific agent session. */
export function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

export async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, body, headers), cap.res, ctx);
  return cap;
}

export async function upload(
  urlPath: string,
  parts: Parameters<typeof makeMultipartReq>[1],
  headers: Record<string, string> = {},
) {
  const cap = makeRes();
  await api.handleApiRequest(makeMultipartReq(urlPath, parts, headers), cap.res, ctx);
  return cap;
}
