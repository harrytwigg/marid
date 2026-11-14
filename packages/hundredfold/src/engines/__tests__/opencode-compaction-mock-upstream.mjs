/**
 * mock upstream for the native-compaction e2e.
 *
 * OpenAI-compatible and text-only. Every reply ends with a usage chunk, so
 * opencode files a token count on the assistant message and its own overflow
 * check has something to read. The first agent step reports
 * MOCK_FIRST_PROMPT_TOKENS of input; every later request reports a small,
 * harmless count so nothing after it crosses a threshold by accident.
 *
 * Requests are classified so the test can count them:
 *   main     the agent step (it offers tools)
 *   title    the title side-call
 *   summary  the compaction agent's summarize
 *   other    anything else (answered like a title)
 *
 * Env:
 *   MOCK_PORT                 port to listen on
 *   MOCK_FIRST_PROMPT_TOKENS  prompt_tokens the first main request reports
 *   MOCK_LOG                  JSONL of every request ({ n, kind, body })
 */
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT || 8941);
const FIRST_PROMPT_TOKENS = Number(process.env.MOCK_FIRST_PROMPT_TOKENS || 1000);
const LATER_PROMPT_TOKENS = 5000;
const LOG = process.env.MOCK_LOG || "/tmp/opencode-compaction-mock-requests.jsonl";
let n = 0;
let main = 0;
writeFileSync(LOG, "");

const frame = (body) => `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1730000000, model: "mock-model", ...body })}\n\n`;

function textResponse(res, text, promptTokens) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(frame({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
  res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write(frame({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 } }));
  res.write("data: [DONE]\n\n");
  res.end();
}

function classify(parsed) {
  if (Array.isArray(parsed?.tools) && parsed.tools.length > 0) return "main";
  const system = JSON.stringify(parsed?.messages?.[0]?.content ?? "");
  if (/title generator/i.test(system)) return "title";
  if (/summarization agent/i.test(system)) return "summary";
  return "other";
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    n += 1;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    const kind = classify(parsed);
    appendFileSync(LOG, JSON.stringify({ n, kind, body: raw }) + "\n");
    if (kind === "title" || kind === "other") return textResponse(res, "Mock title", 200);
    if (kind === "summary") return textResponse(res, "Summary: the user asked for short replies; nothing else is pending.", 2000);
    main += 1;
    return textResponse(res, `reply ${main}`, main === 1 ? FIRST_PROMPT_TOKENS : LATER_PROMPT_TOKENS);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock upstream on ${PORT}`));
