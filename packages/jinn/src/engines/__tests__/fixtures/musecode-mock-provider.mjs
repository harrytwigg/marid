// A mock Meta provider for the Muse Code real-binary e2e: the model catalog
// (`GET /muse-code/models`) and a Responses-API SSE stream (`POST /responses`)
// that carries a `response.subscription_usage` frame.
//
// usage: node musecode-mock-provider.mjs <port|0> <log-file> <catalog.json> [mode]
// It prints `listening <port>` once bound (use port 0 to take a free one) and
// appends one JSON line per request to the log.
//
// Modes:
//   (none)      every request is answered
//   ratelimit   the first two requests are 429 rate limits (retry-after: 1)
//   quota       every request is a 429 `tier_limit_error` that names its reset
//               (`resets_at`, epoch seconds: MOCK_QUOTA_RESET, default an hour ahead)
//   hang        the response starts and then never finishes (a turn to interrupt)
//   tool        the first request is a call to the `bash` tool (MOCK_TOOL_COMMAND,
//               default `echo hi-from-tool`); the next, once the tool has run, is the answer
import http from "node:http";
import fs from "node:fs";

const [port, log, catalogFile, mode] = process.argv.slice(2);
let requests = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(log, `${JSON.stringify({ method: req.method, url: req.url, body: body.slice(0, 3000) })}\n`);
    if (req.url.startsWith("/muse-code/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(catalogFile, "utf8"));
      return;
    }
    const n = requests++;
    if (mode === "ratelimit" && n < 2) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
      return;
    }
    if (mode === "quota") {
      const resetsAt = Number(process.env.MOCK_QUOTA_RESET) || Math.floor(Date.now() / 1000) + 3600;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Usage limit reached", type: "tier_limit_error", resets_at: resetsAt } }));
      return;
    }
    if (mode === "tool" && n === 0) {
      toolCall(res);
      return;
    }
    answer(res, n);
  });
});

function toolCall(res) {
  const now = Math.floor(Date.now() / 1000);
  const id = `resp_${now}_tool`;
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: JSON.stringify({ command: process.env.MOCK_TOOL_COMMAND || "echo hi-from-tool" }), status: "completed" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  let seq = 0;
  const write = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: seq++ })}\n\n`);
  write({ type: "response.created", response: { id, object: "response", status: "in_progress", model: "muse-spark-1.2", output: [] } });
  write({ type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } });
  write({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: call.arguments });
  write({ type: "response.output_item.done", output_index: 0, item: call });
  write({ type: "response.completed", response: { id, object: "response", status: "completed", model: "muse-spark-1.2", output: [call], usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  res.end();
}

function answer(res, n) {
  const now = Math.floor(Date.now() / 1000);
  const text = `mock answer ${n}`;
  const id = `resp_${now}_${n}`;
  const mid = `msg_${n}`;
  const frames = [
    { type: "response.created", response: { id, object: "response", status: "in_progress", model: "muse-spark-1.2", output: [] } },
    { type: "response.subscription_usage", subscription: { tier: "everyday", window: { used_percent: 42, window_duration_mins: 300, resets_at: now + 3600 }, weekly: { used_percent: 17, resets_at: now + 86400 * 3 } } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: mid, role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: mid, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: mid, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: mid, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: mid, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id, object: "response", status: "completed", model: "muse-spark-1.2", output: [{ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  let seq = 0;
  const write = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: seq++ })}\n\n`);
  if (mode === "hang") {
    // Started, and never finished: the turn stays open until it is interrupted.
    write(frames[0]);
    write(frames[2]);
    write(frames[3]);
    write({ type: "response.output_text.delta", item_id: mid, output_index: 0, content_index: 0, delta: "thinking" });
    return;
  }
  for (const e of frames) write(e);
  res.end();
}

server.listen(Number(port), "127.0.0.1", () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
