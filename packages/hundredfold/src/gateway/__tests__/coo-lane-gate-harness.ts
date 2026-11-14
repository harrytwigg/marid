import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/** Shared fixture for the COO land-gate HTTP suites. HUNDREDFOLD_HOME must be set
 *  before those files import the gateway — this module is that import. */
export const COO_GATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-coo-workflow-gate-"));
process.env.HUNDREDFOLD_HOME = COO_GATE_HOME;
fs.mkdirSync(path.join(COO_GATE_HOME, "org"), { recursive: true });
fs.writeFileSync(
  path.join(COO_GATE_HOME, "org", "platform-manager.yaml"),
  "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nengine: codex\nmodel: gpt-5.5\npersona: Generic route-test manager.\n",
);
fs.writeFileSync(
  path.join(COO_GATE_HOME, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Generic route-test worker.\n",
);

export function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw) as Record<string, string>; } catch { return { raw } as Record<string, string>; }
    },
  };
}

export function toolHeaders(sessionId: string): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

export function requestOf(urlPath: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  });
}

export function spoofPortalHeaders(portalId: string): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: portalId,
  };
}
