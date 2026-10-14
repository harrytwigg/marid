/**
 * Mock OpenAI-compatible upstream for the OpenCode 2 server-mode e2e.
 *
 * Directives in the newest user message pick the answer:
 *   TOOLCALL  first step calls the `shell` tool, the next answers "tool done"
 *   MCPCALL   the same with the `jinn_echo` MCP tool (when it is offered)
 *   CALLTOOL=<name>  the same with the named tool, and the arguments in
 *             ARGS64=<base64 JSON> (none without it)
 *   SLOW      streams forty words, 250 ms apart (time to stop the turn)
 *   E400ONCE  answers the first request 400 `{"model":…}` (a pre-stream 400)
 *   E429      answers 429 under the URL prefix MOCK_LIMITED (default: everywhere)
 * Anything else answers "hello from mock". A compaction request answers with
 * a summary in the template opencode asks for; a request without tools (the
 * title) answers "Mock title".
 *
 * Env: MOCK_PORT, MOCK_LOG (JSONL of every request), MOCK_LIMITED.
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT || 18432);
const LOG = process.env.MOCK_LOG || "/dev/null";
const LIMITED = process.env.MOCK_LIMITED || "";
const SUMMARY = [
  "## Objective", "- Mock objective", "", "## Requirements", "- (none)", "", "## Decisions", "- (none)", "",
  "## Work State", "### Completed", "- (none)", "", "### Active", "- (none)", "", "### Blocked", "- (none)", "",
  "## Next Move", "1. (none)", "", "## Relevant Files", "- (none)", "", "## Important Context", "- (none)", "",
].join("\n");
let failedOnce = false;

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } })}\n\n`;

function text(res, words, delayMs) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: "" }, null));
  let i = 0;
  const next = () => {
    if (res.destroyed) return;
    if (i < words.length) {
      res.write(chunk({ content: words[i++] }, null));
      return setTimeout(next, delayMs);
    }
    res.write(chunk({}, "stop"));
    res.write(usage);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  next();
}

function toolCall(res, name, args) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  res.write(chunk({ role: "assistant", content: null, tool_calls: [call] }, null));
  res.write(chunk({}, "tool_calls"));
  res.write(usage);
  res.write("data: [DONE]\n\n");
  res.end();
}

function fail(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "1" } : {}) });
  res.end(JSON.stringify(body));
}

function answer(req, res, body) {
  const messages = body.messages || [];
  const users = messages.filter((m) => m.role === "user");
  // Directives count in the prompt itself, not in the notes Jinn puts in front
  // of it (a stopped request's notice quotes that request's directive).
  const lastUser = JSON.stringify(users.at(-1)?.content ?? "").split("---").at(-1);
  const last = messages.at(-1);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const tools = hasTools ? body.tools.map((t) => t.function?.name) : [];
  appendFileSync(LOG, `${JSON.stringify({ url: req.url, model: body.model, hasTools, tools, lastRole: last?.role, lastUser, all: JSON.stringify(messages) })}\n`);
  if (lastUser.includes("summarize the conversation")) return text(res, [SUMMARY], 0);
  if (!hasTools) return text(res, ["Mock title"], 0);
  if (lastUser.includes("E400ONCE") && !failedOnce) {
    failedOnce = true;
    return fail(res, 400, { model: body.model });
  }
  if (lastUser.includes("E429") && (!LIMITED || req.url.startsWith(`/${LIMITED}/`))) {
    return fail(res, 429, { error: { message: "mock rate limit", type: "rate_limit" } });
  }
  if (lastUser.includes("TOOLCALL") && last?.role !== "tool") return toolCall(res, "shell", { command: "echo hi-from-tool", description: "echo" });
  if (lastUser.includes("MCPCALL") && last?.role !== "tool" && tools.includes("jinn_echo")) return toolCall(res, "jinn_echo", {});
  const named = /CALLTOOL=([A-Za-z0-9_-]+)/.exec(lastUser)?.[1];
  const args64 = /ARGS64=([A-Za-z0-9+/=]+)/.exec(lastUser)?.[1];
  if (named && last?.role !== "tool") return toolCall(res, named, args64 ? JSON.parse(Buffer.from(args64, "base64").toString()) : {});
  if (last?.role === "tool") return text(res, ["tool done"], 0);
  if (lastUser.includes("SLOW")) return text(res, Array.from({ length: 40 }, (_, i) => `w${i} `), 250);
  return text(res, ["hello from mock"], 0);
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    answer(req, res, body);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock upstream on ${PORT}`));
