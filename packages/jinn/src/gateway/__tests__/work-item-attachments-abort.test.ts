import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { api, call, ctx, operatorHeaders, store, tmp } from "./helpers/work-item-attachments-harness.js";
import { logger } from "../../shared/logger.js";

/**
 * A download whose client goes away, or whose source fails, after the status
 * line is on the wire. Runs behind a real HTTP server: the failure only exists
 * once a socket can close under a response that is still writing.
 *
 * The server records each handler promise, the way `http.Server` would drop
 * it: a rejection here is an unhandled rejection in production, which ends a
 * gateway that has no safety net installed.
 */

const SIZE = 8 * 1024 * 1024;
const content = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i += 4) content.writeUInt32LE(i, i);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: http.Server;
let base: string;
const handled: Array<Promise<void>> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handled.push(api.handleApiRequest(req, res, ctx));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
  handled.length = 0;
});

async function attachLarge(title: string) {
  const source = path.join(tmp, `${title.replace(/\W+/g, "-")}.bin`);
  fs.writeFileSync(source, content);
  const item = store.createWorkItem({ title });
  const posted = await call("POST", `/api/work-items/${item.id}/attachments`, { path: source }, operatorHeaders);
  expect(posted.status).toBe(201);
  return `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}?download=1`;
}

/** Read the status line and one body chunk, then drop the connection. */
function abortAfterFirstChunk(urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${urlPath}`, { headers: operatorHeaders }, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
    });
    req.on("error", (err) => {
      if (!req.destroyed) reject(err);
    });
  });
}

/** Read the whole response, resolving whether it completes or is cut off. */
function fetchAll(urlPath: string, onFirstChunk?: () => void): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    const chunks: Buffer[] = [];
    const cut = () => resolve({ status, body: Buffer.concat(chunks), complete: false });
    const req = http.get(`${base}${urlPath}`, { headers: operatorHeaders }, (res) => {
      status = res.statusCode ?? 0;
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunks.length === 1) onFirstChunk?.();
      });
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks), complete: res.complete }));
      res.on("error", cut);
    });
    // After the status line, a reset is the truncation under test, not a failure to connect.
    req.on("error", (err) => (status ? cut() : reject(err)));
  });
}

async function settledHandlers() {
  return Promise.allSettled(handled);
}

describe("attachment download interrupted mid-stream", () => {
  it("a client that hangs up mid-download is not an error, and the next download is served in full", async () => {
    const url = await attachLarge("abort mid download");
    const errors = vi.spyOn(logger, "error");

    // Twice: the reported crash came on the second download of the same file.
    for (const attempt of [1, 2]) {
      expect(await abortAfterFirstChunk(url), `attempt ${attempt}`).toBe(200);
      const outcomes = await settledHandlers();
      expect(outcomes.map((o) => o.status), `attempt ${attempt}`).toEqual(["fulfilled"]);
      handled.length = 0;
    }
    expect(errors.mock.calls.flat().join("\n")).not.toMatch(/API error|Premature close|ERR_HTTP_HEADERS_SENT/);

    const full = await fetchAll(url);
    expect(full.status).toBe(200);
    expect(full.complete).toBe(true);
    expect(digest(full.body)).toBe(digest(content));
    expect((await settledHandlers()).map((o) => o.status)).toEqual(["fulfilled"]);
  });

  it("a source that fails after the headers are sent cuts the response instead of writing a second status", async () => {
    const url = await attachLarge("read fails mid download");
    const errors = vi.spyOn(logger, "error");
    // The source fails only once the client holds the first chunk, so the
    // status line is certainly on the wire when it does.
    let clientHasFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => (clientHasFirstChunk = resolve));
    vi.spyOn(fs, "createReadStream").mockImplementationOnce(() => {
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(content.subarray(0, 64 * 1024));
          void firstChunk.then(() => this.destroy(Object.assign(new Error("simulated read failure"), { code: "EIO" })));
        },
      }) as unknown as ReturnType<typeof fs.createReadStream>;
    });

    const cut = await fetchAll(url, clientHasFirstChunk);
    expect(cut.status).toBe(200);
    // A truncated body, never a 200 that looks whole or a JSON error spliced in.
    expect(cut.complete).toBe(false);
    expect(cut.body.length).toBeLessThan(SIZE);
    expect(cut.body.toString("latin1")).not.toContain("simulated read failure");
    expect((await settledHandlers()).map((o) => o.status)).toEqual(["fulfilled"]);
    // A real fault is still reported.
    expect(errors.mock.calls.flat().join("\n")).toMatch(/simulated read failure/);
    handled.length = 0;

    const full = await fetchAll(url);
    expect(full.status).toBe(200);
    expect(full.complete).toBe(true);
    expect(digest(full.body)).toBe(digest(content));
  });
});
