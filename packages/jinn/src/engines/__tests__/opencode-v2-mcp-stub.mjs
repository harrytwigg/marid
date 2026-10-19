/**
 * A stdio MCP server standing in for the jinn server in the OpenCode 2 e2e:
 * one tool, `echo`, which answers `ECHO:<STUB_MARK>` so the test can see the
 * staged environment reached it.
 */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "jinn", version: "0.0.1" } } });
  } else if (m.method === "tools/list") {
    send({ id: m.id, result: { tools: [{ name: "echo", description: "Echo a mark", inputSchema: { type: "object", properties: {} } }] } });
  } else if (m.method === "tools/call") {
    send({ id: m.id, result: { content: [{ type: "text", text: `ECHO:${process.env.STUB_MARK ?? ""}` }] } });
  } else if (m.id !== undefined) {
    send({ id: m.id, result: {} });
  }
});
