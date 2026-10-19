#!/usr/bin/env node
// A stand-in for the OpenCode 2 CLI, speaking the surface Jinn uses, in the
// shapes a real 2.0.29 server answers with (captured event streams, a message
// store listing and the server's own OpenAPI document):
//   --version                       prints `opencode v2.0.29`
//   serve --port P --hostname H     HTTP API with basic auth (`opencode` and
//                                   $OPENCODE_SERVER_PASSWORD)
// Like the real server it answers JSON routes as `{data: ...}` (but /api/info
// and /interrupt bare), every route it does not know with 200 text/html (its web UI's fallback page, which
// includes /global/health: that is how the pool tells 2.x from 1.x), and a
// session it does not know with 404 {_tag: "SessionNotFoundError"}.
//
// What it models, as observed on the real server:
//   - a prompt becomes an inbox item at once (inbox.enqueued); the session
//     then runs an EXECUTION: execution.started, then each input is delivered
//     (inbox.delivered) and answered by one or more steps, then idle:
//     execution.succeeded|failed|interrupted. An input queued while an
//     execution runs is delivered after the running one's steps, inside the
//     same execution (one execution.succeeded at the end);
//   - an interrupt fails the running step with {type: "aborted"} and ends the
//     execution `interrupted`; one that lands while no execution runs answers
//     {interrupted: false};
//   - every execution leaves an `idle` item in the store carrying its outcome;
//   - model switches are `session.model.selected` plus a `model-switched` item;
//   - a compaction is its own execution: compaction.started {inputID},
//     compaction.ended (no inputID) or compaction.failed, then
//     execution.succeeded either way;
//   - MCP servers connect lazily: GET /api/mcp answers [] the first time and
//     `connected` for every server of the OPENCODE_CONFIG file afterwards.
//
// Turn behaviour is steered by the directive words in the prompt text AFTER ITS
// LAST `---` (Jinn puts its notices and the system prompt before it):
//   TOOL        one shell tool step (finish tool-calls), then the text "tool done"
//   SLOWTOOL    the same, with a tool that runs 1.5 s (time to steer an input in)
//   SLOW        a text step that takes 2 s
//   HANG        the step runs until interrupted
//   FAIL        step.failed and execution.failed {type: provider.invalid-request, status: 400}
//   RETRY       retry.scheduled 200 ms ahead, then a successful step on the same
//               assistantMessageID
//   RETRYFAR    retry.scheduled with `at` an hour ahead, then nothing until interrupted
//   NOTEXT      a step that runs 1.5 s and ends "stop" with no text
//   RETRYSLOW   retry.scheduled an hour ahead, then 100 ms later a new attempt
//               (step.started, same assistantMessageID) whose text takes 800 ms
//   RETRYLOOP   five retry.scheduled an hour ahead, 200 ms apart, then the step
//               ends and the text `fake:retryloop` answers
//   OTHERMODEL  one step on another model than the session's (its step.started names
//               it), which answers `fake:othermodel`; the session's model is unchanged
//   PERMISSION  a tool step that asks permission.asked and waits (1.5 s at most)
//               for the reply; the answer is `permission:<decision>`
//   QUESTION    a question tool step that raises form.created and waits (1.5 s at
//               most) for the form's DELETE; the answer is `question:<dismissed|unanswered>`
//   NOIDLE      the answer's text is streamed, but neither step.ended nor any
//               execution.* event is (the store holds the finished reply and the
//               idle; /api/session/active stops listing the session)
//   DROPSTREAM  one tool step, then every event stream ends and the server carries
//               on unobserved
//   (none)      the text `fake:<the text after the last --->`
// A /compact fails (compaction.failed) when the session's newest user prompt
// carries the directive FAILCOMPACT.
//
// Test hooks:
//   FAKE_V2_OPERATOR_BUSY_MS  an operator input (no Jinn metadata) is already
//                             running in the session for that long whenever a
//                             prompt arrives at an idle session
//   FAKE_V2_LOG               a file each verb appends `<verb> <args>` to
//   FAKE_V2_HEARTBEAT_MS      how often the event stream sends its `: heartbeat` comment (default 10 s)
//   FAKE_V2_VERSION           what --version and /api/info report (default 2.0.29)
//   FAKE_V2_CLI_VERSION       what --version alone reports instead ("none": it
//                             fails, as an unreadable binary does)
//   FAKE_V2_SERVE_FAIL=1      `serve` exits at once
//   FAKE_V2_API_INFO_FAIL     `<n>[:<status>]`: the first n /api/info requests
//                             answer that status (default 503) instead of the version
// GET /test/log returns the requests the server saw ({at, method, path, body}),
// GET /test/info how it was started (argv, the OPENCODE_CONFIG file's contents).
import http from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const verb = argv[0];
const VERSION = process.env.FAKE_V2_VERSION ?? "2.0.29";
const [infoFailCount, infoFailStatus] = (process.env.FAKE_V2_API_INFO_FAIL ?? "0").split(":");
const apiInfoFail = { count: Number(infoFailCount), status: Number(infoFailStatus ?? 503) };
let apiInfoFailed = 0;
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.FAKE_V2_LOG) fs.appendFileSync(process.env.FAKE_V2_LOG, `${`${verb} ${argv.slice(1).join(" ")}`.trim()}\n`);

if (verb === "--version") {
  const cli = process.env.FAKE_V2_CLI_VERSION ?? VERSION;
  if (cli === "none") process.exit(1);
  process.stdout.write(`opencode v${cli}\n`);
  process.exit(0);
}
if (verb !== "serve") {
  process.stderr.write(`fake-opencode-v2: unsupported verb ${verb}\n`);
  process.exit(2);
}

const COST = 0.01;
const TOKENS = { input: 1200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } };
const DEFAULT_MODEL = { providerID: "mock", id: "m1", variant: "default" };
const PROMPT_WAIT_MS = 1500;

function serve() {
  if (process.env.FAKE_V2_SERVE_FAIL === "1") {
    process.stderr.write("serve: failing on purpose\n");
    process.exit(3);
  }
  const port = Number(flag("--port"));
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const operatorBusyMs = Number(process.env.FAKE_V2_OPERATOR_BUSY_MS ?? 0);
  const requests = [];
  const clients = new Set();
  const sessions = new Map();
  let seq = 0;
  let mcpCalls = 0;
  let config = null;
  try { config = process.env.OPENCODE_CONFIG ? JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8")) : null; } catch { config = "unreadable"; }
  const info = {
    pid: process.pid, cwd: process.cwd(), argv, config, jinnSessionId: process.env.JINN_SESSION_ID ?? null, hasPassword: Boolean(password),
    commandTimeoutMs: process.env.JINN_OPENCODE_COMMAND_TIMEOUT_MS ?? null,
  };

  const newId = (prefix) => `${prefix}_test${String(++seq).padStart(6, "0")}`;
  const now = () => Date.now();

  const publish = (type, data) => {
    const frame = `data: ${JSON.stringify({ id: newId("evt"), created: now(), type, data })}\n\n`;
    for (const res of clients) res.write(frame);
  };

  // ── Sessions ──────────────────────────────────────────────────────────────

  function createSession(body) {
    const id = newId("ses");
    const session = {
      id,
      model: body.model ? { providerID: body.model.providerID, id: body.model.id, variant: body.model.variant ?? "default" } : { ...DEFAULT_MODEL },
      agent: body.agent,
      permissions: body.permissions ?? [],
      metadata: undefined,
      directory: body.location?.directory ?? "/work",
      created: now(),
      items: [],
      inbox: [],
      running: false,
      interrupted: false,
      wake: null,
      pending: new Map(),
    };
    sessions.set(id, session);
    publish("session.created", { sessionID: id, slug: "test-session", version: VERSION, projectID: "global", location: { directory: session.directory } });
    return session;
  }

  const sessionInfo = (s) => ({
    id: s.id,
    projectID: "global",
    model: s.model,
    ...(s.agent ? { agent: s.agent } : {}),
    ...(s.metadata ? { metadata: s.metadata } : {}),
    cost: 0,
    tokens: TOKENS,
    time: { created: s.created, updated: now() },
    location: { directory: s.directory },
  });

  const inboxInfo = (s, item) => ({ id: item.id, sessionID: s.id, time: { created: item.created }, type: item.type, payload: item.payload, delivery: item.delivery });

  function enqueue(s, fields) {
    const item = { id: fields.id ?? newId("msg"), created: now(), type: fields.type, payload: fields.payload, delivery: fields.delivery ?? "queue", operatorBusyMs: fields.operatorBusyMs };
    if (item.delivery === "steer") s.inbox.unshift(item);
    else s.inbox.push(item);
    publish("session.inbox.enqueued", { inboxID: item.id, sessionID: s.id, item: { type: item.type, payload: item.payload, delivery: item.delivery } });
    return item;
  }

  /** Sleep that an interrupt cuts short; true when it did. */
  const sleep = (s, ms) => new Promise((resolve) => {
    if (s.interrupted) return resolve(true);
    const timer = setTimeout(() => { s.wake = null; resolve(false); }, ms);
    s.wake = () => { clearTimeout(timer); s.wake = null; resolve(true); };
  });

  /** Wait for a permission reply or a form's DELETE: its answer, or "timeout". */
  const waitAnswer = (s, id, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { s.pending.delete(id); resolve("timeout"); }, ms);
    s.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
  });

  // ── Steps ─────────────────────────────────────────────────────────────────

  const toolBlock = (id, name, state) => ({ type: "tool", id, name, executed: false, state, time: { created: now(), ran: now(), completed: now() } });

  function startStep(s, assistantId = newId("msg")) {
    const item = { id: assistantId, time: { created: now() }, type: "assistant", agent: s.agent ?? "build", model: { ...s.model }, content: [] };
    s.items.push(item);
    publish("session.step.started", { sessionID: s.id, agent: item.agent, model: item.model, assistantMessageID: item.id, snapshot: "0".repeat(40), started: item.time.created });
    return item;
  }

  function streamed(s, item) {
    item.time.streamed = now();
    publish("session.step.streamed", { sessionID: s.id, assistantMessageID: item.id });
  }

  const rawFinish = (finish) => (finish === "tool-calls" ? "tool_calls" : finish);

  function endStep(s, item, finish, over = {}) {
    Object.assign(item, { finish, rawFinish: rawFinish(finish), cost: COST, tokens: TOKENS });
    item.time.completed = now();
    if (over.silent) return;
    publish("session.step.ended", { sessionID: s.id, assistantMessageID: item.id, finish, rawFinish: rawFinish(finish), cost: COST, tokens: TOKENS });
    publish("session.usage.updated", { sessionID: s.id, cost: COST, tokens: TOKENS });
  }

  function failStep(s, item, error) {
    item.finish = "error";
    item.error = error;
    item.time.completed = now();
    publish("session.step.failed", { sessionID: s.id, assistantMessageID: item.id, error, snapshot: "0".repeat(40), files: [] });
  }

  const ABORTED = { type: "aborted", message: "Step interrupted" };

  function startText(s, item, ordinal = 0) {
    publish("session.text.started", { sessionID: s.id, assistantMessageID: item.id, ordinal });
  }

  function endText(s, item, text, ordinal = 0) {
    item.content.push({ type: "text", text });
    publish("session.text.ended", { sessionID: s.id, assistantMessageID: item.id, ordinal, text });
  }

  /** A step that answers with `text` after `waitMs`; "interrupted" when cut short. */
  async function textStep(s, text, opts = {}) {
    const item = opts.item ?? startStep(s);
    await sleep(s, 4);
    startText(s, item);
    if (opts.waitMs && await sleep(s, opts.waitMs)) return failAborted(s, item);
    if (s.interrupted) return failAborted(s, item);
    endText(s, item, text);
    streamed(s, item);
    if (opts.noEnd) {
      endStep(s, item, "stop", { silent: true });
      return "ok";
    }
    endStep(s, item, "stop");
    return "ok";
  }

  function failAborted(s, item) {
    failStep(s, item, ABORTED);
    return "interrupted";
  }

  /** One tool round trip; `during` runs between the tool being called and its result. */
  async function toolStep(s, spec) {
    const item = startStep(s);
    await sleep(s, 4);
    const id = newId("call");
    const input = spec.input ?? { command: "echo hi-from-tool", description: "echo" };
    publish("session.tool.input.started", { sessionID: s.id, assistantMessageID: item.id, id, name: spec.name ?? "shell" });
    publish("session.tool.input.ended", { sessionID: s.id, assistantMessageID: item.id, id, text: JSON.stringify(input) });
    publish("session.tool.called", { sessionID: s.id, assistantMessageID: item.id, id, input, executed: false });
    streamed(s, item);
    const outcome = spec.during ? await spec.during(item, id) : undefined;
    if (s.interrupted) return failAborted(s, item);
    const name = spec.name ?? "shell";
    if (outcome?.fail) {
      const error = { type: "tool.execution", message: outcome.fail };
      publish("session.tool.failed", { sessionID: s.id, assistantMessageID: item.id, id, error });
      item.content.push(toolBlock(id, name, { status: "error", input, error }));
    } else {
      const content = [{ type: "text", text: spec.output ?? "hi-from-tool\n" }];
      publish("session.tool.progress", { sessionID: s.id, assistantMessageID: item.id, id, metadata: {} });
      publish("session.tool.success", { sessionID: s.id, assistantMessageID: item.id, id, content, metadata: { status: "completed", exit: 0 } });
      item.content.push(toolBlock(id, name, { status: "completed", input, content, metadata: { status: "completed", exit: 0 } }));
    }
    endStep(s, item, "tool-calls");
    return "ok";
  }

  const RATE_LIMIT = { type: "provider.rate-limit", message: "mock 429", status: 429, response: { body: "{\"error\":{\"message\":\"mock 429\"}}" } };

  // ── What an input does ────────────────────────────────────────────────────

  const directiveOf = (text) => String(text ?? "").split("---").pop().trim();
  const has = (directive, word) => new RegExp(`\\b${word}\\b`).test(directive);

  /** Runs one delivered input; resolves to "ok", "interrupted" or {failed: error}. */
  async function runInput(s, item) {
    if (item.type === "compaction") return await runCompaction(s, item);
    if (item.operatorBusyMs) return await textStep(s, "operator reply", { waitMs: item.operatorBusyMs });
    const text = String(item.payload.text ?? "");
    const d = directiveOf(text);
    const step = DIRECTIVES.find(([word]) => has(d, word));
    if (step) return await step[1](s, d);
    return await textStep(s, `fake:${d}`);
  }

  async function failTurn(s) {
    const item = startStep(s);
    const error = { type: "provider.invalid-request", message: "malformed request body", status: 400, response: { body: "{}" } };
    failStep(s, item, error);
    return { failed: error };
  }

  async function retryTurn(s) {
    const item = startStep(s);
    publish("session.retry.scheduled", { sessionID: s.id, assistantMessageID: item.id, attempt: 2, at: now() + 200, error: RATE_LIMIT });
    if (await sleep(s, 200)) return failAborted(s, item);
    publish("session.step.started", { sessionID: s.id, agent: item.agent, model: item.model, assistantMessageID: item.id, snapshot: "0".repeat(40), started: now() });
    return await textStep(s, "fake:retried", { item });
  }

  async function retryFarTurn(s) {
    const item = startStep(s);
    publish("session.retry.scheduled", { sessionID: s.id, assistantMessageID: item.id, attempt: 2, at: now() + 3_600_000, error: RATE_LIMIT });
    await sleep(s, 60_000);
    return failAborted(s, item);
  }

  async function otherModelTurn(s) {
    const own = s.model;
    s.model = { providerID: "mock", id: "other", variant: "default" };
    const outcome = await textStep(s, "fake:othermodel");
    s.model = own;
    return outcome;
  }

  async function permissionTurn(s) {
    let decision = "timeout";
    const first = await toolStep(s, {
      during: async (item, callId) => {
        const id = newId("per");
        publish("permission.asked", {
          id,
          sessionID: s.id,
          action: "shell",
          resources: ["echo hi-from-tool"],
          save: ["echo *"],
          source: { type: "tool", messageID: item.id, id: callId },
        });
        decision = await waitAnswer(s, id, PROMPT_WAIT_MS);
        return undefined;
      },
    });
    return first === "ok" ? await textStep(s, `permission:${decision}`) : first;
  }

  async function questionTurn(s) {
    let answer = "unanswered";
    const first = await toolStep(s, {
      name: "question",
      input: { questions: [{ question: "Pick one?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] },
      during: async (item, callId) => {
        const id = newId("frm");
        publish("form.created", {
          form: {
            id,
            sessionID: s.id,
            title: "Questions",
            metadata: { kind: "question", tool: { messageID: item.id, id: callId } },
            fields: [{ key: "q0", type: "text", label: "Pick one?" }],
          },
        });
        const reply = await waitAnswer(s, id, PROMPT_WAIT_MS);
        if (reply === "dismissed") answer = "dismissed";
        return { fail: "The question was dismissed" };
      },
    });
    return first === "ok" ? await textStep(s, `question:${answer}`) : first;
  }

  async function dropStreamTurn(s) {
    const first = await toolStep(s, {});
    for (const res of clients) res.end();
    clients.clear();
    return first === "ok" ? await textStep(s, "tool done") : first;
  }

  async function noIdleTurn(s) {
    s.noExecutionEvent = true;
    return await textStep(s, "fake:noidle", { noEnd: true });
  }

  /** Inputs steered in while an input runs join it at the next step: they
   *  are delivered there, and the steps after answer them as well (2.0.29). */
  function deliverSteered(s) {
    while (s.inbox[0]?.delivery === "steer") {
      const item = s.inbox.shift();
      s.items.push({ id: item.id, time: { created: now() }, type: "user", text: item.payload.text });
      publish("session.inbox.delivered", { sessionID: s.id, inboxID: item.id });
    }
  }

  async function toolTurn(s, d) {
    const slow = has(d, "SLOWTOOL");
    const first = await toolStep(s, slow ? { during: async () => { await sleep(s, 1500); } } : {});
    if (first !== "ok") return first;
    deliverSteered(s);
    return await textStep(s, "tool done");
  }

  async function hangTurn(s) {
    const item = startStep(s);
    startText(s, item);
    await sleep(s, 60_000);
    return failAborted(s, item);
  }

  async function noTextTurn(s) {
    const item = startStep(s);
    if (await sleep(s, 1500)) return failAborted(s, item);
    streamed(s, item);
    endStep(s, item, "stop");
    return "ok";
  }

  async function retrySlowTurn(s) {
    const item = startStep(s);
    publish("session.retry.scheduled", { sessionID: s.id, assistantMessageID: item.id, attempt: 2, at: Date.now() + 3_600_000, error: RATE_LIMIT });
    if (await sleep(s, 100)) return failAborted(s, item);
    publish("session.step.started", { sessionID: s.id, agent: item.agent, model: item.model, assistantMessageID: item.id, snapshot: "0".repeat(40), started: now() });
    startText(s, item);
    if (await sleep(s, 800)) return failAborted(s, item);
    endText(s, item, "fake:retryslow");
    streamed(s, item);
    endStep(s, item, "stop");
    return "ok";
  }

  async function retryLoopTurn(s) {
    const item = startStep(s);
    for (let attempt = 2; attempt < 7; attempt++) {
      publish("session.retry.scheduled", { sessionID: s.id, assistantMessageID: item.id, attempt, at: Date.now() + 3_600_000, error: RATE_LIMIT });
      if (await sleep(s, 200)) return failAborted(s, item);
    }
    endStep(s, item, "stop");
    return await textStep(s, "fake:retryloop");
  }

  /** The directives, in the order they are tried. */
  const DIRECTIVES = [
    ["TOOL", toolTurn],
    ["SLOWTOOL", toolTurn],
    ["SLOW", (s) => textStep(s, "fake:slow", { waitMs: 2000 })],
    ["HANG", hangTurn],
    ["FAIL", failTurn],
    ["RETRY", retryTurn],
    ["RETRYFAR", retryFarTurn],
    ["RETRYLOOP", retryLoopTurn],
    ["RETRYSLOW", retrySlowTurn],
    ["NOTEXT", noTextTurn],
    ["OTHERMODEL", otherModelTurn],
    ["PERMISSION", permissionTurn],
    ["QUESTION", questionTurn],
    ["NOIDLE", noIdleTurn],
    ["DROPSTREAM", dropStreamTurn],
  ];

  async function runCompaction(s, item) {
    const failing = has(directiveOf([...s.items].reverse().find((m) => m.type === "user")?.text), "FAILCOMPACT");
    const replaced = [...s.items].reverse().find((m) => m.type === "assistant" && m.tokens);
    publish("session.compaction.started", { sessionID: s.id, reason: "manual", recent: "", inputID: item.id });
    await sleep(s, 20);
    const stored = { type: "compaction", id: item.id, time: { created: now() }, reason: "manual", cost: COST, tokens: replaced?.tokens ?? TOKENS };
    if (failing) {
      const error = { type: "compaction.failed", message: "Compaction summary did not match the required template" };
      s.items.push({ ...stored, status: "failed", error });
      publish("session.compaction.failed", { sessionID: s.id, reason: "manual", inputID: item.id, error, cost: COST, tokens: TOKENS });
    } else {
      const summary = "## Objective\n- Mock objective\n";
      s.items.push({ ...stored, status: "completed", model: s.model, summary, recent: "" });
      publish("session.usage.updated", { sessionID: s.id, cost: COST, tokens: TOKENS });
      // 2.0.29's compaction.ended carries no inputID.
      publish("session.compaction.ended", { sessionID: s.id, reason: "manual", model: s.model, text: summary });
    }
    return "ok";
  }

  // ── Executions ────────────────────────────────────────────────────────────

  async function execution(s) {
    if (s.running) return;
    s.running = true;
    s.interrupted = false;
    s.noExecutionEvent = false;
    publish("session.execution.started", { sessionID: s.id });
    let outcome = "succeeded";
    let error;
    while (s.inbox.length) {
      const item = s.inbox.shift();
      if (item.type === "user") {
        s.items.push({ id: item.id, time: { created: now() }, type: "user", text: item.payload.text, ...(item.payload.metadata ? { metadata: item.payload.metadata } : {}) });
      }
      publish("session.inbox.delivered", { sessionID: s.id, inboxID: item.id });
      const result = await runInput(s, item);
      if (result === "interrupted") { outcome = "interrupted"; break; }
      if (result !== "ok") { outcome = "failed"; error = result.failed; break; }
    }
    s.items.push({ id: newId("msg"), time: { created: now() }, type: "idle", outcome, ...(error ? { error } : {}) });
    s.running = false;
    if (!s.noExecutionEvent) {
      if (outcome === "interrupted") publish("session.execution.interrupted", { sessionID: s.id, reason: "user" });
      else if (outcome === "failed") publish("session.execution.failed", { sessionID: s.id, error });
      else publish("session.execution.succeeded", { sessionID: s.id });
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const data = (res, payload) => json(res, 200, { data: payload });
  const noContent = (res) => { res.writeHead(204); res.end(); };
  const html = (res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>opencode</body></html>");
  };
  const notFound = (res, id) => json(res, 404, { _tag: "SessionNotFoundError", sessionID: id, message: `Session not found: ${id}` });

  async function readBody(req) {
    let text = "";
    for await (const chunk of req) text += chunk;
    try { return text ? JSON.parse(text) : undefined; } catch { return undefined; }
  }

  function openEventStream(res) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), Number(process.env.FAKE_V2_HEARTBEAT_MS ?? 10_000));
    res.on("close", () => { clearInterval(heartbeat); clients.delete(res); });
  }

  /** The session routes: /api/session/:id/<rest>. */
  async function sessionRoute(req, res, url, s, rest, body) {
    const method = req.method;
    if (rest === "" && method === "GET") return data(res, sessionInfo(s));
    if (rest === "" && method === "PATCH") {
      if (body && "metadata" in body) s.metadata = body.metadata && Object.keys(body.metadata).length ? body.metadata : undefined;
      return noContent(res);
    }
    if (rest === "/model" && method === "POST") {
      const previous = { ...s.model };
      s.model = { providerID: body.model.providerID, id: body.model.id, variant: body.model.variant ?? "default" };
      s.items.push({ id: newId("msg"), time: { created: now() }, type: "model-switched", model: s.model, previous });
      publish("session.model.selected", { sessionID: s.id, model: s.model, previous });
      return noContent(res);
    }
    if (rest === "/agent" && method === "POST") {
      s.agent = body.agent;
      return noContent(res);
    }
    if (rest === "/prompt" && method === "POST") {
      // An operator input is already running when the prompt arrives at an idle session.
      if (!s.running && !s.inbox.length && operatorBusyMs > 0) {
        enqueue(s, { type: "user", payload: { text: "operator request" }, delivery: "steer", operatorBusyMs });
      }
      const item = enqueue(s, {
        id: body.id,
        type: "user",
        payload: { text: body.text, ...(body.metadata ? { metadata: body.metadata } : {}) },
        // 2.0.29 stores a prompt posted with no delivery as a steer.
        delivery: body.delivery === "queue" ? "queue" : "steer",
      });
      setImmediate(() => void execution(s));
      return data(res, inboxInfo(s, item));
    }
    if (rest === "/compact" && method === "POST") {
      const item = enqueue(s, { type: "compaction", payload: {}, delivery: body?.delivery === "steer" ? "steer" : "queue" });
      setImmediate(() => void execution(s));
      return data(res, inboxInfo(s, item));
    }
    if (rest === "/interrupt" && method === "POST") {
      const interrupted = s.running && !s.interrupted;
      if (interrupted) {
        s.interrupted = true;
        s.wake?.();
      }
      return json(res, 200, { interrupted });
    }
    if (rest === "/message" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const ordered = url.searchParams.get("order") === "asc" ? [...s.items] : [...s.items].reverse();
      return json(res, 200, { data: ordered.slice(0, limit), cursor: { previous: null, next: null } });
    }
    if (rest === "/inbox" && method === "GET") return data(res, s.inbox.map((item) => inboxInfo(s, item)));
    const inboxItem = /^\/inbox\/([^/]+)$/.exec(rest);
    if (inboxItem && method === "PATCH") {
      // The terminal's per-item steer/queue toggle: a steer goes to the front.
      const at = s.inbox.findIndex((item) => item.id === decodeURIComponent(inboxItem[1]));
      if (at < 0) return json(res, 404, { _tag: "InboxItemNotFoundError", message: "no such inbox item" });
      const [item] = s.inbox.splice(at, 1);
      item.delivery = body?.delivery === "steer" ? "steer" : "queue";
      if (item.delivery === "steer") s.inbox.unshift(item);
      else s.inbox.push(item);
      publish("session.inbox.delivery.changed", { sessionID: s.id, inboxID: item.id, delivery: item.delivery });
      return noContent(res);
    }
    if (inboxItem && method === "DELETE") {
      const at = s.inbox.findIndex((item) => item.id === decodeURIComponent(inboxItem[1]));
      if (at < 0) return json(res, 404, { _tag: "InboxItemNotFoundError", message: "no such inbox item" });
      s.inbox.splice(at, 1);
      return noContent(res);
    }
    const reply = /^\/permission\/([^/]+)\/reply$/.exec(rest);
    if (reply && method === "POST") return answerPending(res, s, decodeURIComponent(reply[1]), body?.decision ?? "once");
    const form = /^\/form\/([^/]+)$/.exec(rest);
    if (form && method === "DELETE") return answerPending(res, s, decodeURIComponent(form[1]), "dismissed");
    return html(res);
  }

  function answerPending(res, s, id, value) {
    const resolve = s.pending.get(id);
    if (!resolve) return json(res, 404, { _tag: "NotFoundError", message: `nothing pending as ${id}` });
    s.pending.delete(id);
    resolve(value);
    return noContent(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization ?? "";
    if (password && auth !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      return res.end("Unauthorized");
    }
    if (url.pathname.startsWith("/test/")) {
      if (url.pathname === "/test/log") return json(res, 200, requests);
      if (url.pathname === "/test/info") return json(res, 200, info);
      return json(res, 404, {});
    }
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
    const entry = { at: now(), method: req.method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }) };
    requests.push(entry);

    // ServerInfo and the interrupt answer are bare, as on the real server.
    if (url.pathname === "/api/info" && apiInfoFailed < apiInfoFail.count) {
      apiInfoFailed++;
      return json(res, apiInfoFail.status, { message: "unavailable" });
    }
    if (url.pathname === "/api/info") return json(res, 200, { version: VERSION, pid: process.pid });
    if (url.pathname === "/api/event") return openEventStream(res);
    if (url.pathname === "/api/mcp" && req.method === "GET") {
      const names = Object.keys(config?.mcp?.servers ?? {});
      const listed = mcpCalls++ === 0 ? [] : names.map((name) => ({ name, status: { status: "connected" } }));
      entry.answered = listed.map((m) => `${m.name}:${m.status.status}`);
      return data(res, listed);
    }
    if (url.pathname === "/api/session" && req.method === "POST") return data(res, sessionInfo(createSession(body ?? {})));
    if (url.pathname === "/api/session/active" && req.method === "GET") {
      return data(res, Object.fromEntries([...sessions.values()].filter((s) => s.running).map((s) => [s.id, { type: "running" }])));
    }
    const route = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (route) {
      const id = decodeURIComponent(route[1]);
      const session = sessions.get(id);
      if (!session) return notFound(res, id);
      return await sessionRoute(req, res, url, session, route[2] ?? "", body);
    }
    return html(res);
  }

  const server = http.createServer((req, res) => { void handle(req, res).catch((err) => { res.writeHead(500); res.end(String(err)); }); });
  server.listen(port, flag("--hostname") ?? "127.0.0.1");
  const stop = () => { for (const res of clients) res.end(); server.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

serve();
