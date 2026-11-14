import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SsePtyProxy, finishedBackgroundTaskIds } from "../sse-pty-proxy.js";

/** The shapes the Claude CLI actually sends (copied from real transcripts). */
const bashFinished = (id: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n` +
  `<output-file>/tmp/claude/tasks/${id}.output</output-file>\n<status>completed</status>\n` +
  `<summary>Background command "poll deploy log" completed (exit code 0)</summary>\n</task-notification>`;
const monitorEvent = (id: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<summary>Monitor event: "CI"</summary>\n` +
  `<event>check passed</event>\n</task-notification>`;
const SYSTEM_PREAMBLE = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n";

describe("finishedBackgroundTaskIds", () => {
  it("reads the task id from a finished background task's notification", () => {
    expect(finishedBackgroundTaskIds([{ role: "user", content: bashFinished("bzzhy2ds0") }])).toEqual(["bzzhy2ds0"]);
  });

  it("finds notifications inside text blocks and behind the system preamble", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: SYSTEM_PREAMBLE + bashFinished("a1") },
        { type: "text", text: bashFinished("b2") },
      ],
    }];
    expect(finishedBackgroundTaskIds(messages)).toEqual(["a1", "b2"]);
  });

  it("finds a notification delivered alongside a tool result mid-turn", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_9", content: "done" },
        { type: "text", text: `<system-reminder>${bashFinished("c3")}</system-reminder>` },
      ],
    }];
    expect(finishedBackgroundTaskIds(messages)).toEqual(["c3"]);
  });

  it("treats a Monitor's per-event notice as no ending", () => {
    expect(finishedBackgroundTaskIds([{ role: "user", content: monitorEvent("m1") }])).toEqual([]);
  });

  it("reads only the newest message: older notifications are history, already counted", () => {
    const messages = [
      { role: "user", content: bashFinished("old") },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next question" },
    ];
    expect(finishedBackgroundTaskIds(messages)).toEqual([]);
  });

  it("returns nothing for malformed input", () => {
    expect(finishedBackgroundTaskIds(undefined)).toEqual([]);
    expect(finishedBackgroundTaskIds([])).toEqual([]);
    expect(finishedBackgroundTaskIds([null])).toEqual([]);
    expect(finishedBackgroundTaskIds([{ role: "assistant", content: bashFinished("x") }])).toEqual([]);
  });
});

describe("SsePtyProxy task notifications", () => {
  const proxies: SsePtyProxy[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) proxy.stop();
    await Promise.all(servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ));
  });

  async function proxyWith(onTaskNotifications: (ids: string[]) => void): Promise<{ port: number; upstreamBodies: string[] }> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        upstreamBodies.push(Buffer.concat(chunks).toString("utf-8"));
        res.writeHead(200);
        res.end("ok");
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const proxy = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: (upstream.address() as AddressInfo).port },
      primaryAgent: false,
      onTaskNotifications,
    });
    proxies.push(proxy);
    return { port: await proxy.start(), upstreamBodies };
  }

  function post(port: number, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("reports the finished task ids of an agent request and still forwards it unchanged", async () => {
    const seen: string[][] = [];
    const { port, upstreamBodies } = await proxyWith((ids) => seen.push(ids));
    const body = JSON.stringify({ tools: [{ name: "Bash" }], messages: [{ role: "user", content: bashFinished("t1") }] });

    expect(await post(port, body)).toBe(200);

    expect(seen).toEqual([["t1"]]);
    expect(upstreamBodies).toEqual([body]);
  });

  it("forwards the request even when the observer throws", async () => {
    const { port, upstreamBodies } = await proxyWith(() => { throw new Error("boom"); });
    const body = JSON.stringify({ tools: [{ name: "Bash" }], messages: [{ role: "user", content: bashFinished("t1") }] });

    expect(await post(port, body)).toBe(200);
    expect(upstreamBodies).toEqual([body]);
  });

  it("does not report anything for an auxiliary request without tools", async () => {
    const seen: string[][] = [];
    const { port } = await proxyWith((ids) => seen.push(ids));

    await post(port, JSON.stringify({ messages: [{ role: "user", content: bashFinished("t1") }] }));

    expect(seen).toEqual([]);
  });
});
