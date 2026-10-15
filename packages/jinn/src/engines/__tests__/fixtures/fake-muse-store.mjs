// The plumbing the fake `muse serve` stands on: the request log, the session
// store shared by every process, and the JSON-RPC framing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STATE_DIR = process.env.FAKE_MUSE_STATE_DIR || path.join(os.tmpdir(), "fake-muse-state");
const LOG = process.env.FAKE_MUSE_LOG;
fs.mkdirSync(STATE_DIR, { recursive: true });

export function log(entry) {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}
log({
  start: true,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(
    ["JINN_SESSION_ID", "JINN_EMPLOYEE", "CLAUDECODE", "CODEX_HOME", "META_API_KEY", "HOME"].filter((k) => k in process.env).map((k) => [k, process.env[k]]),
  ),
});

export function uuid7() {
  const b = crypto.randomBytes(16);
  let t = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
export const notify = (method, params) => out({ method, params });
export const reply = (id, result) => out({ id, result });
export const fail = (id, code, message, data) => out({ id, error: { code, message, ...(data ? { data } : {}) } });

export const sessionFile = (id) => path.join(STATE_DIR, `${id}.json`);
export const readSession = (id) => {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), "utf8")); } catch { return undefined; }
};
export const writeSession = (session) => fs.writeFileSync(sessionFile(session.sessionId), JSON.stringify(session));

export const sessionView = (s) => ({
  activeTurnId: null,
  approvalMode: { mode: "allowAll", source: "startup" },
  kind: "root",
  modelId: s.modelId ?? null,
  providerId: "meta",
  sessionId: s.sessionId,
  status: "idle",
  turnCount: s.turns ?? 0,
  workspaceRoot: s.workspaceRoot,
});

