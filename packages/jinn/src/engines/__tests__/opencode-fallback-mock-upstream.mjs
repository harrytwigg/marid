/**
 * Mock upstream for the provider-fallback e2e: two OpenAI-compatible
 * providers on one port. Requests under /go/ are refused the way an exhausted
 * Go subscription refuses them (429, GoUsageLimitError, a long retry-after);
 * requests under /or/ are answered.
 *
 * Env: MOCK_PORT, MOCK_LOG (JSONL of every request), MOCK_ANSWER (the main
 * request's answer).
 */
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const LOG = process.env.MOCK_LOG || "/dev/null";
const ANSWER = process.env.MOCK_ANSWER || "fallback answer";
if (LOG !== "/dev/null") writeFileSync(LOG, "");

const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

function text(res, t) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: t }, null));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let tools = 0;
    try { tools = (JSON.parse(raw).tools || []).length; } catch {}
    if (LOG !== "/dev/null") appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), url: req.url, main: tools > 0 })}\n`);
    if (req.url.startsWith("/go/")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } }));
      return;
    }
    text(res, tools > 0 ? ANSWER : "untitled");
  });
}).listen(Number(process.env.MOCK_PORT), "127.0.0.1");
