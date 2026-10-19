import fs from "node:fs";
import path from "node:path";
import type { StreamDelta, EngineResult } from "../../../shared/types.js";
import { GrokEngine } from "../../grok.js";
import type { FakeProc } from "./grok-chat-blocks-proc.js";
import { spawnCalls } from "./grok-chat-blocks-proc.js";

/** Shared fixtures for live mid-turn Grok tests. The fake process
 *  lives in grok-chat-blocks-proc.ts so the child_process mock can load it
 *  without importing GrokEngine. */

export { spawnCalls, makeFakeProc } from "./grok-chat-blocks-proc.js";
export type { FakeProc } from "./grok-chat-blocks-proc.js";

export const flush = () => new Promise((r) => setTimeout(r, 0));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

export function makeCwd(home: string, name: string): { cwd: string; sessionsRoot: string } {
  const cwd = path.join(home, name);
  fs.mkdirSync(cwd, { recursive: true });
  const resolved = fs.realpathSync(cwd);
  return {
    cwd,
    sessionsRoot: path.join(home, ".grok", "sessions", encodeURIComponent(resolved)),
  };
}

export function writeTranscript(sessionsRoot: string, sessionId: string, lines: unknown[]): void {
  const file = path.join(sessionsRoot, sessionId, "updates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

export const toolCall = (sessionId: string, toolCallId: string) => ({
  method: "session/update",
  params: {
    sessionId,
    update: { sessionUpdate: "tool_call", toolCallId, title: "read_file", rawInput: { target_file: "note.txt" } },
  },
});

export const toolCallDone = (sessionId: string, toolCallId: string) => ({
  method: "session/update",
  params: {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      title: "read_file",
      content: [{ type: "content", content: { type: "text", text: "hello from the file" } }],
    },
  },
});

export const END_LINE = JSON.stringify({ type: "end", stopReason: "EndTurn" }) + "\n";

export function startFreshTurn(cwd: string, sessionId: string):
{ deltas: StreamDelta[]; proc: FakeProc; done: Promise<EngineResult> } {
  const deltas: StreamDelta[] = [];
  const engine = new GrokEngine();
  const done = engine.run({
    prompt: "read note.txt and summarise it",
    cwd,
    sessionId,
    model: "grok-build",
    onStream: (delta: StreamDelta) => deltas.push(delta),
  } as any) as Promise<EngineResult>;
  return { deltas, proc: spawnCalls[spawnCalls.length - 1], done };
}

export function streamedText(deltas: StreamDelta[]): string {
  return deltas.filter((d) => d.type === "text").map((d) => d.content).join("");
}
