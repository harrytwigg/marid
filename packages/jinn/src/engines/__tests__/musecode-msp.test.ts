import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { MspClient, MspClosedError, MspError, MspTimeoutError, uuidv7 } from "../musecode-msp.js";
import { MspProcess } from "../musecode-process.js";

/** A client wired to in-memory pipes: `toServer` is what it wrote, `fromServer` is where the test speaks as the host. */
function pair() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const client = new MspClient(toServer, fromServer);
  const written: Array<Record<string, any>> = [];
  let buffer = "";
  toServer.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      written.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  const say = (message: Record<string, unknown>) => fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { client, toServer, fromServer, written, say, flush };
}

describe("uuidv7", () => {
  it("has the version and variant bits of a v7 UUID and carries the timestamp", () => {
    const at = Date.UTC(2026, 9, 15, 12, 0, 0);
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(at);
  });

  it("sorts by time and does not repeat", () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(Array.from({ length: 200 }, () => uuidv7())).size).toBe(200);
  });
});

describe("MspClient", () => {
  afterEach(() => vi.useRealTimers());

  it("writes one JSON-RPC request per line and resolves it with the matching response, whatever the order", async () => {
    const { client, written, say, flush } = pair();
    const first = client.request("first", { a: 1 });
    const second = client.request("second");
    await flush();
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 1, method: "first", params: { a: 1 } },
      { jsonrpc: "2.0", id: 2, method: "second", params: {} },
    ]);
    say({ id: 2, result: { which: "second" } });
    say({ id: 1, result: { which: "first" } });
    await expect(first).resolves.toEqual({ which: "first" });
    await expect(second).resolves.toEqual({ which: "second" });
  });

  it("rejects with the server's code, message and typed kind", async () => {
    const { client, say, flush } = pair();
    const request = client.request("session/resume");
    await flush();
    say({ id: 1, error: { code: -32020, message: "session x not found", data: { kind: "sessionNotFound", sessionId: "x" } } });
    const err = await request.catch((e) => e);
    expect(err).toBeInstanceOf(MspError);
    expect(err).toMatchObject({ code: -32020, message: "session x not found", kind: "sessionNotFound", data: { sessionId: "x" } });
  });

  it("hands notifications to the handler and ignores a response nobody asked for", async () => {
    const { client, say, flush } = pair();
    const seen: Array<[string, unknown]> = [];
    client.onNotification((method, params) => seen.push([method, params]));
    say({ method: "turn/started", params: { turnId: "t1" } });
    say({ id: 99, result: {} });
    await flush();
    expect(seen).toEqual([["turn/started", { turnId: "t1" }]]);
  });

  it("survives a handler that throws and a line that is not JSON", async () => {
    const { client, fromServer, say, flush } = pair();
    const seen: string[] = [];
    client.onNotification((method) => {
      seen.push(method);
      if (method === "boom") throw new Error("handler failed");
    });
    say({ method: "boom", params: {} });
    fromServer.write("this is not json\n");
    say({ method: "after", params: {} });
    await flush();
    expect(seen).toEqual(["boom", "after"]);
  });

  it("answers a server-initiated request with the handler's result, echoing its id", async () => {
    const { client, written, say, flush } = pair();
    client.onServerRequest((method, params) => ({ got: method, sessionId: params.sessionId }));
    say({ id: "srv-1", method: "approval/request", params: { sessionId: "s1" } });
    await flush();
    expect(written).toEqual([{ jsonrpc: "2.0", id: "srv-1", result: { got: "approval/request", sessionId: "s1" } }]);
  });

  it("answers a server request with an error when the handler throws, and when there is none", async () => {
    const { client, written, say, flush } = pair();
    say({ id: 1, method: "userInput/request", params: {} });
    await flush();
    expect(written[0]).toMatchObject({ id: 1, error: { code: -32601 } });
    client.onServerRequest(() => { throw new Error("cannot present"); });
    say({ id: 2, method: "userInput/request", params: {} });
    await flush();
    expect(written[1]).toMatchObject({ id: 2, error: { code: -32603, message: "cannot present" } });
  });

  it("initialize sends the client info and capabilities, then the initialized notification", async () => {
    const { client, written, say, flush } = pair();
    const done = client.initialize({ clientInfo: { name: "marid", version: "1.2.3" }, userInputDialogs: false });
    await flush();
    expect(written[0]).toMatchObject({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "marid", version: "1.2.3" }, capabilities: { userInputDialogs: false } },
    });
    expect(written).toHaveLength(1);
    say({ id: 1, result: { serverInfo: { name: "muse", version: "1.4.8" } } });
    await expect(done).resolves.toMatchObject({ serverInfo: { version: "1.4.8" } });
    expect(written[1]).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
  });

  it("omits capabilities when none were asked for", async () => {
    const { client, written, say, flush } = pair();
    const done = client.initialize({ clientInfo: { name: "marid", version: "1" } });
    await flush();
    expect(written[0]!.params).toEqual({ clientInfo: { name: "marid", version: "1" } });
    say({ id: 1, result: {} });
    await done;
  });

  it("rejects every outstanding request when the output closes, and refuses new ones", async () => {
    const { client, fromServer, flush } = pair();
    const closed: string[] = [];
    client.onClose((reason) => closed.push(reason));
    const outstanding = client.request("turn/start");
    await flush();
    fromServer.end();
    await expect(outstanding).rejects.toBeInstanceOf(MspClosedError);
    expect(client.closed).toBe(true);
    expect(closed).toHaveLength(1);
    await expect(client.request("again")).rejects.toBeInstanceOf(MspClosedError);
    // A listener added after the end is told at once.
    const late = vi.fn();
    client.onClose(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("times a request out without leaving it pending", async () => {
    vi.useFakeTimers();
    const { client, say } = pair();
    const request = client.request("model/list", {}, { timeoutMs: 500 });
    const assertion = expect(request).rejects.toBeInstanceOf(MspTimeoutError);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    // The late answer finds nothing waiting and changes nothing.
    say({ id: 1, result: {} });
  });

  it("end() closes the host's stdin", async () => {
    const { client, toServer } = pair();
    const finished = new Promise<void>((resolve) => toServer.on("end", () => resolve()));
    client.end();
    await finished;
  });
});

const node = process.execPath;
const spec = (script: string) => ({ bin: node, args: ["-e", script], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } });

describe("MspProcess", () => {
  const live: MspProcess[] = [];
  const start = (script: string) => {
    const proc = new MspProcess(spec(script));
    live.push(proc);
    return proc;
  };
  afterEach(async () => {
    await Promise.all(live.splice(0).map((p) => p.shutdown(50)));
  });

  it("talks to a real child and leaves when its stdin is closed", async () => {
    const proc = start(`
      require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echo: m.method } }) + "\\n");
      }).on("close", () => process.exit(0));
    `);
    await expect(proc.client.request("ping")).resolves.toEqual({ echo: "ping" });
    const exit = await proc.shutdown();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(proc.hasExited).toBe(true);
  });

  it("closes the client and reports the exit when the child dies", async () => {
    const proc = start(`process.stderr.write("boom on boot"); process.exit(7)`);
    // The output closing is what ends the connection; the exit itself follows.
    await new Promise<string>((resolve) => proc.client.onClose(resolve));
    expect(await proc.waitForExit()).toEqual({ code: 7, signal: null });
    expect(proc.stderrTail).toBe("boom on boot");
    await expect(proc.client.request("late")).rejects.toBeInstanceOf(MspClosedError);
  });

  it("sends SIGTERM to a child that ignores the closed stdin", async () => {
    const proc = start(`process.stdin.resume(); setInterval(() => {}, 1000);`);
    const exit = await proc.shutdown(100);
    expect(exit.signal).toBe("SIGTERM");
  });

  it("sends SIGKILL to a child that ignores SIGTERM too", async () => {
    const proc = start(`process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write("ready\\n");`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const exit = await proc.shutdown(100);
    expect(exit.signal).toBe("SIGKILL");
  });

  it("reports a binary that cannot be spawned", async () => {
    const proc = new MspProcess({ bin: "/nonexistent/muse", args: [], cwd: process.cwd(), env: {} });
    live.push(proc);
    await proc.waitForExit();
    expect(proc.failedToSpawn?.message).toMatch(/ENOENT/);
    await expect(proc.client.request("x")).rejects.toBeInstanceOf(MspClosedError);
  });
});
