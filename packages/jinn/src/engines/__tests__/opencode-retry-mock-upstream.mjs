/**
 * mock upstream for the Jinn-path retry e2e.
 *
 * OpenAI-compatible, scripted so the first *main* request asks for a
 * side-effecting bash tool, the next is the transient 400, and the one after
 * returns text `done`. Requests are classified as "main" when their body
 * carries the sentinel user text; anything else (title generation, summaries)
 * gets a harmless text reply and is not counted in the script.
 *
 * Env:
 *   MOCK_PORT     port to listen on
 *   MOCK_MODE     "success" (default) | "exhausted" (400 forever after req1)
 *   MOCK_SENTINEL unique marker in the main prompt body
 *   MOCK_SIDEFX   path the tool appends to
 *   MOCK_LOG      JSONL of every request body
 */
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT || 8931);
const MODE = process.env.MOCK_MODE || "success";
const SENTINEL = process.env.MOCK_SENTINEL || "OPENCODE_RETRY_SENTINEL";
const SIDEFX = process.env.MOCK_SIDEFX || "/tmp/opencode-retry-sidefx.log";
const LOG = process.env.MOCK_LOG || "/tmp/opencode-retry-mock-requests.jsonl";
let n = 0;
let main = 0;
writeFileSync(LOG, "");

const chunk = (delta, finish) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1730000000,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

function sse(res, ...lines) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const l of lines) res.write(l);
  res.write("data: [DONE]\n\n");
  res.end();
}

function toolCallResponse(res) {
  const args = JSON.stringify({ command: `echo x >> ${SIDEFX}` });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    chunk(
      {
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: "call_opencode_retry", type: "function", function: { name: "bash", arguments: "" } }],
      },
      null,
    ),
  );
  res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }, null));
  res.write(chunk({}, "tool_calls"));
  res.write("data: [DONE]\n\n");
  res.end();
}

function textResponse(res, text) {
  sse(res, chunk({ role: "assistant", content: text }, null), chunk({}, "stop"));
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    n += 1;
    // "main" = the agent step, not the title/summary side-call. Both carry the
    // user text, but only the agent request offers tools.
    let toolsLen = 0;
    try {
      const parsed = JSON.parse(raw);
      toolsLen = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
    } catch {}
    const isMain = raw.includes(SENTINEL) && toolsLen > 0;
    appendFileSync(LOG, JSON.stringify({ n, main: isMain, endpointId: req.headers["x-opencode-endpoint-id"] || null, body: raw }) + "\n");

    if (!isMain) {
      textResponse(res, "untitled"); // title / summary side-call
      return;
    }

    main += 1;
    if (main === 1) return toolCallResponse(res);
    if (MODE === "exhausted" || main === 2) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "mock-model" }));
      return;
    }
    return textResponse(res, "done");
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock upstream on ${PORT}`));
