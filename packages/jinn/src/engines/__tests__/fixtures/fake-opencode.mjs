#!/usr/bin/env node
// A stand-in for the opencode CLI, speaking exactly the surface Jinn uses
// (shapes taken from opencode 1.18.31's own OpenAPI document and event stream):
//   serve --port P --hostname H     HTTP API with basic auth, SSE on /event
//   run [...]                       a plain turn (the `run` mode / fallback)
//   attach URL [-s ses]             the TUI as a client
// It models what Jinn relies on, as observed on the real server: a prompt is
// posted under a client-supplied message id; each step of the reply is an
// assistant message whose parentID is that id; prompts queue per session and
// run in one busy period; and an abort that lands before a prompt is picked up
// is lost (the prompt then runs anyway).
// Turn behaviour is steered by the prompt text:
//   HANG        the turn runs until aborted
//   SLOWBUSY    the prompt is picked up 500 ms after it is posted
//   SLOWSTART   the session is busy with the prompt for 800 ms before its
//               first reply exists (so a client that subscribes meanwhile
//               sees that reply from its start)
//   SLOW        the answer takes 600 ms
//   PERMISSION  the turn asks for a permission and waits (1.5 s at most) for a reply
//   PERMWAIT    the same, but waits a minute: a prompt blocked on a human
//   QUESTION    the turn asks the user a question (unless the prompt turned the
//               question tool off) and waits for it
//   CHILDQ      a sub-session of the turn asks a question and waits for it
//   FAIL        the turn ends with a session.error
//   DRIFT       the stream carries parts in a shape Jinn does not know, while
//               the stored message holds the real answer (an API change)
//   NOIDLE      the turn ends with no signal at all on the stream: no final
//               message.updated, no idle status, no session.idle
//   STATUSIDLE  the turn ends with an idle session.status but no session.idle
//   MULTISTEP   two tool round trips (each its own reply, finish=tool-calls),
//               then the answer — the order real 1.18.31 emits
//   TOOLONLY    one tool round trip, then a final reply with no text
//   NOCOMPLETE  the final reply's completion never reaches the stream (only
//               the session going idle does)
//   EARLIER     the reply goes back to the session's previous request instead
//               (as a real model did with an aborted one still unanswered in
//               the history): it asks a permission, runs a tool round,
//               then answers `earlier:<that request's text>`. Unless the prompt
//               carries a synthetic part saying that request was cancelled
//: then, as the real model did in every live probe, it
//               answers its own prompt as usual. A request Jinn recorded on a
//               stopped prompt's metadata is what such a notice quotes.
//   IGNORENOTICE  with EARLIER: take the previous request up even so
//   ORPHAN      the reply is left as a server killed mid-reply leaves it: never
//               completed, no error; the session goes idle
//   FAILSTART   the prompt fails with a session.error before any reply exists
//   GHOSTIDLE   the stream says busy then idle at once, but /session/status
//               keeps the session busy for 1.5 s, and the prompt never runs
//   MIDFAIL     a provider error partway through: a step says something and
//               calls a tool, then the next step's request is refused before
//               its stream starts. The ending is the order real 1.18.32 and
//               1.18.34 emit for a pre-stream 400: session.error, idle, the
//               failed reply's message.updated (completed, error, no finish),
//               idle again. ORDER=<err|idle|msg,...> emits those instead, in
//               the order given.
// Directives are read from the prompt's own text only, never from a synthetic
// part (which may quote another prompt's directives).
// Test hooks: FAKE_OPENCODE_SERVE_FAIL=1 makes `serve` exit at once;
// FAKE_OPENCODE_VERSION sets the version /global/health reports (default
// 1.18.31, "none" for no version); FAKE_OPENCODE_SERVE_LOG names a file each
// `serve` start appends a line to; FAKE_OPENCODE_CREATE_DELAY_MS delays the
// answer to POST /session; FAKE_OPENCODE_HISTORY_DELAY_MS delays the answer
// to GET /session/<id>/message?limit=N; FAKE_OPENCODE_PATCH_FAIL=1 makes
// PATCH …/part/<id> answer 500, and FAKE_OPENCODE_PATCH_DELAY_MS delays it;
// FAKE_OPENCODE_SUMMARIZE_DELAY_MS holds POST …/summarize open; FAKE_OPENCODE_BOOTSTRAP_MS
// holds every instance request (all but /global/health and /test/*) until the
// server's first one is that old, as opencode bootstraps its instance on the
// first such request; GET /test/log returns what the server saw;
// GET /test/info how it was started.
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const verb = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const emitLine = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function serve() {
  if (process.env.FAKE_OPENCODE_SERVE_FAIL === "1") {
    process.stderr.write("serve: failing on purpose\n");
    process.exit(3);
  }
  if (process.env.FAKE_OPENCODE_SERVE_LOG) fs.appendFileSync(process.env.FAKE_OPENCODE_SERVE_LOG, `serve ${process.pid}\n`);
  const reported = process.env.FAKE_OPENCODE_VERSION ?? "1.18.31";
  const port = Number(flag("--port"));
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const log = [];
  const clients = new Set();
  let bootstrapped;
  // id -> { busy, queue, running, messages, pending: Map<requestId, resolve> }
  const sessions = new Map();
  let seq = 0;
  let config = null;
  try { config = process.env.OPENCODE_CONFIG ? JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8")) : null; } catch { config = "unreadable"; }
  const info = { pid: process.pid, cwd: process.cwd(), argv, config, jinnSessionId: process.env.JINN_SESSION_ID ?? null, hasPassword: Boolean(password) };

  const publish = (type, properties) => {
    const data = `data: ${JSON.stringify({ type, properties })}\n\n`;
    for (const res of clients) res.write(data);
  };
  // Ascending, like opencode's own ids.
  const newId = (prefix) => `${prefix}_fake${String(++seq).padStart(6, "0")}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const newSession = (parentID) => {
    const id = newId("ses");
    sessions.set(id, { busy: false, queue: [], running: null, messages: [], pending: new Map() });
    publish("session.created", { sessionID: id, info: { id, ...(parentID ? { parentID } : {}) } });
    return id;
  };
  const setStatus = (id, type, end = "both") => {
    const s = sessions.get(id);
    s.busy = type !== "idle";
    if (end === "none") return;
    publish("session.status", { sessionID: id, status: { type } });
    if (type === "idle" && end === "both") publish("session.idle", { sessionID: id });
  };
  const messageUpdated = (sessionID, message) => publish("message.updated", { sessionID, info: message.info });
  // Store a part on the running reply and put it on the stream (`wire` is what
  // goes out; DRIFT changes the shape there only).
  const part = (sessionID, turn, fields) => {
    const p = { id: newId("prt"), sessionID, messageID: turn.reply.info.id, ...fields };
    const parts = turn.reply.parts;
    const open = parts.findIndex((q) => q.type === "text" && p.type === "text" && !q.time?.end);
    if (open >= 0) parts[open] = p;
    else parts.push(p);
    publish("message.part.updated", { sessionID, part: turn.wire(p), time: Date.now() });
  };
  const waitReply = (sessionID, requestId, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { sessions.get(sessionID)?.pending.delete(requestId); resolve("unanswered"); }, ms);
    sessions.get(sessionID).pending.set(requestId, (v) => { clearTimeout(timer); resolve(v); });
  });

  function newReply(sessionID, turn) {
    turn.reply = { info: { id: newId("msg"), sessionID, role: "assistant", parentID: turn.userId, time: { created: Date.now() } }, parts: [] };
    sessions.get(sessionID).messages.push(turn.reply);
    messageUpdated(sessionID, turn.reply);
    part(sessionID, turn, { type: "step-start" });
  }

  /** One tool round trip as real opencode emits it: the tool, its step-finish,
   *  then the reply completed with finish=tool-calls; the next step is a new reply. */
  function toolRound(sessionID, turn, n) {
    part(sessionID, turn, { type: "tool", callID: `call_${turn.userId}_${n}`, tool: "bash", state: { status: "completed", input: { command: `echo ${n}` }, output: `out-${n}` } });
    part(sessionID, turn, { type: "step-finish", reason: "tool-calls", tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } }, cost: 0.0005 });
    turn.reply.info.time.completed = Date.now();
    turn.reply.info.finish = "tool-calls";
    messageUpdated(sessionID, turn.reply);
    newReply(sessionID, turn);
  }

  async function runTurn(sessionID, turn) {
    const { text, body } = turn;
    if (text.includes("SLOWSTART")) await sleep(800);
    if (text.includes("FAILSTART")) {
      publish("session.error", { sessionID, error: { name: "APIError", data: { message: "upstream exploded" } } });
      return;
    }
    newReply(sessionID, turn);
    if (text.includes("ORPHAN")) return;
    if (text.includes("MIDFAIL")) return midTurnFailure(sessionID, turn);
    if (text.includes("MULTISTEP")) { toolRound(sessionID, turn, 1); toolRound(sessionID, turn, 2); }
    if (text.includes("TOOLONLY")) {
      toolRound(sessionID, turn, 1);
      part(sessionID, turn, { type: "step-finish", reason: "stop", tokens: { input: 5, output: 0, cache: { read: 0, write: 0 } }, cost: 0 });
      return;
    }
    if (text.includes("HANG")) {
      while (!turn.aborted) await sleep(20);
      return;
    }
    if (text.includes("PERMISSION") || text.includes("PERMWAIT")) {
      const id = newId("per");
      publish("permission.asked", { id, sessionID, permission: "bash", patterns: ["*"], metadata: {}, always: [], tool: { messageID: turn.reply.info.id, callID: "call_1" } });
      const reply = await waitReply(sessionID, id, text.includes("PERMWAIT") ? 60_000 : 1500);
      if (turn.aborted) return;
      part(sessionID, turn, { type: "tool", callID: `call_${turn.userId}`, tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: `permission:${reply}` } });
    }
    if (text.includes("QUESTION") && body.tools?.question !== false) {
      const id = newId("que");
      publish("question.asked", { id, sessionID, questions: [{ question: "which?" }] });
      const reply = await waitReply(sessionID, id, 1500);
      part(sessionID, turn, { type: "text", text: `question:${reply}`, time: { start: 1, end: 2 } });
    }
    if (text.includes("CHILDQ")) {
      const child = newSession(sessionID);
      const id = newId("que");
      publish("question.asked", { id, sessionID: child, questions: [{ question: "which?" }] });
      const reply = await waitReply(child, id, 1500);
      part(sessionID, turn, { type: "text", text: `child-question:${reply}`, time: { start: 1, end: 2 } });
    }
    if (text.includes("SLOW")) await sleep(600);
    if (turn.aborted) return;
    const users = sessions.get(sessionID).messages.filter((m) => m.info.role === "user");
    const earlier = users[users.findIndex((m) => m.info.id === turn.userId) - 1];
    const earlierText = earlier?.parts.filter((p) => !p.synthetic).map((p) => p.text).join("") ?? "none";
    const earlierRequest = earlier?.parts.find((p) => typeof p.metadata?.request === "string")?.metadata.request ?? earlierText;
    const toldCancelled = turn.notices.some((n) => n.includes(earlierRequest));
    if (text.includes("EARLIER") && (!toldCancelled || text.includes("IGNORENOTICE"))) {
      const id = newId("per");
      publish("permission.asked", { id, sessionID, permission: "external_directory", patterns: ["/etc/*"], metadata: {}, always: [], tool: { messageID: turn.reply.info.id, callID: "call_read" } });
      const reply = await waitReply(sessionID, id, 1500);
      part(sessionID, turn, { type: "tool", callID: "call_read", tool: "read", state: { status: "completed", input: { filePath: "/etc/hostname" }, output: `permission:${reply}` } });
      part(sessionID, turn, { type: "step-finish", reason: "tool-calls", tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } }, cost: 0.0005 });
      turn.reply.info.time.completed = Date.now();
      turn.reply.info.finish = "tool-calls";
      messageUpdated(sessionID, turn.reply);
      newReply(sessionID, turn);
      part(sessionID, turn, { type: "text", text: `earlier:${earlierText}`, time: { start: 1, end: 2 } });
      part(sessionID, turn, { type: "step-finish", reason: "stop", tokens: { input: 10, output: 2, cache: { read: 5, write: 0 } }, cost: 0.001 });
      return;
    }
    if (text.includes("FAIL")) {
      publish("session.error", { sessionID, error: { name: "APIError", data: { message: "upstream exploded" } } });
      turn.reply.info.error = { name: "APIError", data: { message: "upstream exploded" } };
      return;
    }
    part(sessionID, turn, { type: "text", text: "partial", time: { start: 1 } });
    part(sessionID, turn, {
      type: "text",
      text: `answer:${text}${body.model ? ` model=${body.model.providerID}/${body.model.modelID}` : ""}${body.agent ? ` agent=${body.agent}` : ""}`,
      time: { start: 1, end: 2 },
    });
    part(sessionID, turn, { type: "step-finish", reason: "stop", tokens: { input: 10, output: 2, cache: { read: 5, write: 0 } }, cost: 0.001 });
    // The stored message carries its usage too, as the real server's does:
    // system prompt and tools included, cached or not.
    turn.reply.info.tokens = { input: 1200, output: 2, cache: { read: 20000, write: 600 } };
  }

  /** MIDFAIL: the turn ends itself, in the order its prompt asks for. */
  function midTurnFailure(sessionID, turn) {
    part(sessionID, turn, { type: "text", text: "Let me verify x before y.", time: { start: 1, end: 2 } });
    toolRound(sessionID, turn, 1);
    const error = { name: "APIError", data: { message: 'Bad Request: {"model":"mock-model"}', statusCode: 400, isRetryable: false } };
    turn.reply.info.error = error;
    turn.reply.info.time.completed = Date.now();
    turn.endedItself = true;
    const emit = {
      err: () => publish("session.error", { sessionID, error }),
      idle: () => setStatus(sessionID, "idle"),
      msg: () => messageUpdated(sessionID, turn.reply),
    };
    for (const step of (turn.text.match(/ORDER=([a-z,]+)/)?.[1] ?? "err,idle,msg,idle").split(",")) emit[step]();
  }

  /** Run the session's queued prompts, one busy period for all of them. */
  async function pump(sessionID) {
    const s = sessions.get(sessionID);
    if (s.running || !s.queue.length) return;
    let end = "both";
    setStatus(sessionID, "busy");
    while (s.queue.length) {
      const turn = s.queue.shift();
      s.running = turn;
      await runTurn(sessionID, turn);
      if (turn.reply && !turn.text.includes("ORPHAN") && !turn.endedItself) {
        turn.reply.info.time.completed = Date.now();
        if (!turn.aborted && !turn.reply.info.error) turn.reply.info.finish = "stop";
        if (!turn.text.includes("NOIDLE") && !turn.text.includes("NOCOMPLETE")) messageUpdated(sessionID, turn.reply);
      }
      s.running = null;
      end = turn.text.includes("NOIDLE") || turn.endedItself ? "none" : turn.text.includes("STATUSIDLE") ? "status" : "both";
      if (turn.aborted) s.queue.length = 0;
    }
    setStatus(sessionID, "idle", end);
  }

  const server = http.createServer(async (req, res) => {
    const expected = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined;
    if (expected && req.headers.authorization !== expected) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const json = raw ? JSON.parse(raw) : {};
    const url = req.url ?? "";
    if (url !== "/global/health" && !url.startsWith("/test/")) {
      bootstrapped ??= new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_OPENCODE_BOOTSTRAP_MS ?? 0)));
      await bootstrapped;
    }
    if (url !== "/event" && !url.startsWith("/test/")) log.push({ method: req.method, url, body: json, at: Date.now() });
    const send = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url === "/global/health") return send({ healthy: true, ...(reported === "none" ? {} : { version: reported }) });
    if (url === "/test/info") return send(info);
    if (url === "/test/log") return send(log);
    if (url === "/session" && req.method === "POST") {
      const delay = Number(process.env.FAKE_OPENCODE_CREATE_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return send({ id: newSession() });
    }
    if (url === "/session/status") {
      return send(Object.fromEntries([...sessions].filter(([, s]) => s.busy).map(([id]) => [id, { type: "busy" }])));
    }
    let m = url.match(/^\/session\/([^/?]+)\/message(?:\?limit=(\d+))?$/);
    if (m && req.method === "GET") {
      const delay = m[2] ? Number(process.env.FAKE_OPENCODE_HISTORY_DELAY_MS ?? 0) : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const s = sessions.get(decodeURIComponent(m[1]));
      // `limit` is the newest that many, oldest first, as on the real server.
      return s ? send(m[2] ? s.messages.slice(-Number(m[2])) : s.messages) : send({ name: "NotFoundError" }, 404);
    }
    m = url.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
    if (m && req.method === "GET") {
      const message = sessions.get(decodeURIComponent(m[1]))?.messages.find((x) => x.info.id === decodeURIComponent(m[2]));
      return message ? send(message) : send({ name: "NotFoundError" }, 404);
    }
    m = url.match(/^\/session\/([^/]+)\/message\/([^/]+)\/part\/([^/]+)$/);
    if (m && req.method === "PATCH") {
      if (process.env.FAKE_OPENCODE_PATCH_FAIL === "1") return send({ name: "UnknownError" }, 500);
      const delay = Number(process.env.FAKE_OPENCODE_PATCH_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const message = sessions.get(decodeURIComponent(m[1]))?.messages.find((x) => x.info.id === decodeURIComponent(m[2]));
      const index = message?.parts.findIndex((q) => q.id === decodeURIComponent(m[3])) ?? -1;
      if (index < 0) return send({ name: "NotFoundError" }, 404);
      // The body is the whole part, as on the real server.
      message.parts[index] = { ...json, id: message.parts[index].id, messageID: message.info.id, sessionID: message.info.sessionID };
      publish("message.part.updated", { sessionID: message.info.sessionID, part: message.parts[index], time: Date.now() });
      return send(message.parts[index]);
    }
    m = url.match(/^\/session\/([^/]+)\/abort$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const s = sessions.get(id);
      if (s?.compacting) s.compacting.aborted = true;
      // Only a prompt already running can be aborted; one still waiting to be
      // picked up is not (the real server loses such an abort too).
      if (s?.running && !s.running.aborted) {
        s.running.aborted = true;
        s.running.reply.info.error = { name: "MessageAbortedError", data: { message: "aborted" } };
        publish("session.error", { sessionID: id, error: s.running.reply.info.error });
        // A permission the aborted prompt was waiting on goes with it.
        for (const [requestId, resolve] of s.pending) { s.pending.delete(requestId); resolve("aborted"); }
      }
      return send(true);
    }
    m = url.match(/^\/session\/([^/]+)\/summarize$/);
    if (m && req.method === "POST") {
      // Compaction (1.18.32): answers `true` once the summary is stored — a
      // user message with a `compaction` part, answered by an assistant message
      // with summary:true. FAKE_OPENCODE_SUMMARIZE_DELAY_MS holds it open; an
      // abort meanwhile fails it.
      const id = decodeURIComponent(m[1]);
      const s = sessions.get(id);
      if (!s) return send({ name: "NotFoundError", data: { message: `Session not found: ${id}` } }, 404);
      if (!json.providerID || !json.modelID) return send({ name: "BadRequest" }, 400);
      const compaction = { aborted: false };
      s.compacting = compaction;
      s.busy = true;
      const delay = Number(process.env.FAKE_OPENCODE_SUMMARIZE_DELAY_MS ?? 20);
      const deadline = Date.now() + delay;
      while (Date.now() < deadline && !compaction.aborted) await new Promise((r) => setTimeout(r, 10));
      s.busy = false;
      s.compacting = null;
      if (compaction.aborted) return send({ name: "MessageAbortedError" }, 500);
      const userId = newId("msg");
      s.messages.push({ info: { id: userId, sessionID: id, role: "user", time: { created: Date.now() } }, parts: [{ id: newId("prt"), type: "compaction" }] });
      s.messages.push({
        // The summarizing call reads the conversation, not the system prompt
        // and tools (live, 1.18.32: 1.5k input against a 21.9k context).
        info: { id: newId("msg"), sessionID: id, role: "assistant", parentID: userId, summary: true, mode: "compaction", cost: 0.002, finish: "stop", tokens: { input: 1500, output: 300, cache: { read: 0, write: 0 } }, time: { created: Date.now(), completed: Date.now() } },
        parts: [{ id: newId("prt"), type: "text", text: "## Objective\n- summary" }],
      });
      return send(true);
    }
    m = url.match(/^\/session\/([^/]+)\/message$/);
    if (m && req.method === "POST") {
      // Only the `noReply` form Jinn uses: store the user message, answer none.
      const id = decodeURIComponent(m[1]);
      const s = sessions.get(id);
      if (!s) return send({ name: "NotFoundError" }, 404);
      if (json.noReply !== true) return send({ error: "fake: only noReply messages" }, 400);
      const userId = newId("msg");
      const parts = (json.parts ?? []).map((p) => ({ id: newId("prt"), ...p, messageID: userId, sessionID: id }));
      const user = { info: { id: userId, sessionID: id, role: "user", time: { created: Date.now() }, ...(json.model ? { model: json.model } : {}) }, parts };
      s.messages.push(user);
      return send(user);
    }
    m = url.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const s = sessions.get(id);
      if (!s) return send({ name: "NotFoundError", data: { message: `Session not found: ${id}` } }, 404);
      const text = (json.parts ?? []).filter((p) => !p.synthetic).map((p) => p.text ?? "").join("");
      const notices = (json.parts ?? []).filter((p) => p.synthetic).map((p) => p.text ?? "");
      const userId = json.messageID ?? newId("msg");
      // Stored as posted, metadata and synthetic flags included, as the real server does.
      const parts = (json.parts ?? []).map((p) => ({ id: newId("prt"), ...p, messageID: userId, sessionID: id }));
      const user = { info: { id: userId, sessionID: id, role: "user", time: { created: Date.now() } }, parts };
      s.messages.push(user);
      messageUpdated(id, user);
      const wire = text.includes("DRIFT") ? (p) => ({ ...p, type: `${p.type}-v2` }) : (p) => p;
      send(undefined, 204);
      if (text.includes("GHOSTIDLE")) {
        setStatus(id, "busy");
        setStatus(id, "idle");
        s.busy = true;
        setTimeout(() => { s.busy = false; }, 1500);
        return;
      }
      setTimeout(() => {
        s.queue.push({ userId, text, notices, body: json, wire, aborted: false });
        void pump(id);
      }, text.includes("SLOWBUSY") ? 500 : 10);
      return;
    }
    m = url.match(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/);
    if (m) {
      const requestId = decodeURIComponent(m[2]);
      for (const s of sessions.values()) {
        const resolve = s.pending.get(requestId);
        if (resolve) { s.pending.delete(requestId); resolve(m[3] === "reject" ? "rejected" : json.reply); }
      }
      return send(true);
    }
    if (url === "/tui/select-session") return send(true);
    return send({ error: "not found" }, 404);
  });
  server.listen(port, flag("--hostname") ?? "127.0.0.1");
  process.on("SIGTERM", () => process.exit(0));
}

if (verb === "serve") {
  serve();
} else if (verb === "run") {
  const prompt = await readStdin();
  emitLine({ type: "text", sessionID: flag("-s") ?? "ses_plain", part: { type: "text", text: `plain:${prompt}` } });
} else if (verb === "attach") {
  process.stdout.write(`ATTACHED ${flag("-s") ?? "none"} pw=${process.env.OPENCODE_SERVER_PASSWORD ? "yes" : "no"}\r\n`);
  process.stdin.on("data", (d) => process.stdout.write(`TYPED ${JSON.stringify(String(d))}\r\n`));
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`fake opencode: unsupported ${argv.join(" ")}\n`);
  process.exit(2);
}
