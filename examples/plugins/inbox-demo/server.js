/**
 * The gateway half of the reference plugin.
 *
 * It stands in for the shape a real integration takes: something outside the
 * gateway produces items, a supervised background task notices them, and the
 * dashboard half approves or rejects each one. Here the outside world is a
 * directory you drop files into, so the example needs no account, no network and
 * no credentials to run.
 *
 * Two exports, and the gateway reads exactly these: a default registrar that
 * returns the plugin's routes, and an optional `watcher` the gateway starts and
 * stops. Importing this file must never start anything by itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Everything this plugin persists lives under one key in its own namespace. */
const MESSAGES_KEY = "messages";

/**
 * The directory the watcher watches.
 *
 * It must stay OUTSIDE the instance's `plugins/` directory. The gateway watches
 * that tree recursively to hot-reload plugins, so an inbox inside it would make
 * every dropped file trigger a rescan, which would reload the very plugin that
 * is reading the file. The default is a temp directory for that reason alone;
 * point `plugins.settings.inbox-demo.inboxDir` at anywhere else you like, as
 * long as it is not under the plugins directory.
 *
 * Exported so a test can assert that property rather than trust this comment.
 */
export function inboxDirectory(settings) {
  const configured = settings?.inboxDir;
  return typeof configured === "string" && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(os.tmpdir(), "hundredfold-inbox-demo");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The request body as JSON, or null when there is nothing usable in it. */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return null;
  }
}

/** One message per file in the inbox, newest last. A file already recorded is
 *  left alone, so a rescan of the directory is not a source of duplicates. */
function ingest(ctx, dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch (err) {
    // The directory was removed under the watcher. Saying so beats an empty
    // inbox that looks like nobody has sent anything.
    ctx.log(`could not read ${dir}: ${err.message}`);
    return;
  }

  const messages = readMessages(ctx);
  const known = new Set(messages.map((message) => message.id));
  const arrived = files.filter((name) => !known.has(name));
  if (arrived.length === 0) return;

  for (const name of arrived) {
    messages.push({ id: name, subject: name, state: "pending", receivedAt: new Date().toISOString() });
  }
  ctx.storage.set(MESSAGES_KEY, messages);
  // One event per arrival, so a dashboard watching the stream can react to each
  // rather than diff two snapshots.
  for (const name of arrived) ctx.emit({ type: "arrived", id: name });
}

function readMessages(ctx) {
  const stored = ctx.storage.get(MESSAGES_KEY);
  return Array.isArray(stored) ? stored : [];
}

/** `POST /approve` and `POST /reject` differ only in the state they write. */
function decide(ctx, state) {
  return async (req, res) => {
    const body = await readJson(req);
    const id = body?.id;
    if (typeof id !== "string" || !id) return sendJson(res, 400, { error: "id must be a non-empty string" });

    const messages = readMessages(ctx);
    const message = messages.find((candidate) => candidate.id === id);
    if (!message) return sendJson(res, 404, { error: `no message "${id}"` });

    message.state = state;
    message.decidedAt = new Date().toISOString();
    ctx.storage.set(MESSAGES_KEY, messages);
    ctx.emit({ type: state, id });
    sendJson(res, 200, { message });
  };
}

/**
 * The route map, keyed by the exact `"METHOD /path"` the gateway matches against.
 * Paths are relative to this plugin's mount at `/api/plugins/inbox-demo/`.
 */
export default function register(ctx) {
  return {
    "GET /messages": (req, res) => sendJson(res, 200, { messages: readMessages(ctx) }),
    "POST /approve": decide(ctx, "approved"),
    "POST /reject": decide(ctx, "rejected"),
  };
}

/** The one FSWatcher this plugin runs. Module-scoped because the gateway
 *  guarantees the previous incarnation is stopped before a new one starts. */
let watching = null;

export const watcher = {
  start(ctx) {
    const dir = inboxDirectory(ctx.settings);
    fs.mkdirSync(dir, { recursive: true });
    // Once up front, because files dropped while the gateway was down are still
    // waiting, and fs.watch only reports what happens after it is attached.
    ingest(ctx, dir);

    watching = fs.watch(dir, () => ingest(ctx, dir));
    // An unhandled "error" on an FSWatcher is thrown at the process. Rejecting
    // the promise this returns is how the gateway's supervisor learns to restart
    // the watcher instead.
    return new Promise((_resolve, reject) => {
      watching.on("error", reject);
    });
  },

  stop() {
    watching?.close();
    watching = null;
  },
};
