import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { api, call, ctx, operatorHeaders, store, tmp } from "./helpers/work-item-attachments-harness.js";
import { logger } from "../../shared/logger.js";

/**
 * A download whose client goes away, or whose source fails, once the route has
 * started on it. Runs behind a real HTTP server: the failures only exist once
 * a socket can close under a response that is still being prepared or written.
 *
 * The server records each handler promise, the way `http.Server` would drop
 * it: a rejection here is an unhandled rejection in production, which ends a
 * gateway that has no safety net installed.
 */

// Lets a test hold the route where it prepares the body (thumbnail and poster
// generation wait here), so the client can leave before the first byte.
const gate = vi.hoisted(() => ({ hold: null as null | { entered: () => void; release: Promise<void> } }));
vi.mock("../attachment-variants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../attachment-variants.js")>();
  return {
    ...actual,
    selectAttachmentVariant: async (...args: Parameters<typeof actual.selectAttachmentVariant>) => {
      const hold = gate.hold;
      if (hold) {
        gate.hold = null;
        hold.entered();
        await hold.release;
      }
      return actual.selectAttachmentVariant(...args);
    },
  };
});

const SIZE = 8 * 1024 * 1024;
const content = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i += 4) content.writeUInt32LE(i, i);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: http.Server;
let base: string;
const handled: Array<Promise<void>> = [];
const responses: http.ServerResponse[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    responses.push(res);
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
  gate.hold = null;
  handled.length = 0;
  responses.length = 0;
});

async function attachLarge(title: string) {
  const source = path.join(tmp, `${title.replace(/\W+/g, "-")}.bin`);
  fs.writeFileSync(source, content);
  const item = store.createWorkItem({ title });
  const posted = await call("POST", `/api/work-items/${item.id}/attachments`, { path: source }, operatorHeaders);
  expect(posted.status).toBe(201);
  return {
    url: `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}?download=1`,
    storagePath: posted.body.attachment.storagePath as string,
  };
}

/**
 * Watch every file the gateway opens for reading. Opens of `target` get what
 * `make()` returns instead of the real stream, unless it returns undefined;
 * every other path reads normally.
 */
function interceptReads(target: string, make?: () => Readable | undefined): string[] {
  const opened: string[] = [];
  const real = fs.createReadStream;
  vi.spyOn(fs, "createReadStream").mockImplementation(((file: fs.PathLike, options?: Parameters<typeof real>[1]) => {
    opened.push(String(file));
    return (String(file) === target ? make?.() : undefined) ?? real(file, options);
  }) as typeof fs.createReadStream);
  return opened;
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
    const { url } = await attachLarge("abort mid download");
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
    const { url, storagePath } = await attachLarge("read fails mid download");
    const errors = vi.spyOn(logger, "error");
    // The source fails only once the client holds the first chunk, so the
    // status line is certainly on the wire when it does.
    let clientHasFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => (clientHasFirstChunk = resolve));
    let failing = true;
    interceptReads(storagePath, () => {
      if (!failing) return undefined;
      failing = false;
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(content.subarray(0, 64 * 1024));
          void firstChunk.then(() => this.destroy(Object.assign(new Error("simulated read failure"), { code: "EIO" })));
        },
      });
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

  it("a client that leaves before the first byte is not an error and no file is opened for it", async () => {
    const { url, storagePath } = await attachLarge("leave before first byte");
    const errors = vi.spyOn(logger, "error");
    const opened = interceptReads(storagePath);
    let entered!: () => void;
    const routeWaiting = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    gate.hold = { entered, release: new Promise<void>((resolve) => (release = resolve)) };

    const req = http.get(`${base}${url}`, { headers: operatorHeaders });
    req.on("error", () => {});
    await routeWaiting;
    req.destroy();
    const [res] = responses;
    if (!res.destroyed) await once(res, "close");
    release();

    expect((await settledHandlers()).map((o) => o.status)).toEqual(["fulfilled"]);
    // pipeline() into a closed response never closes its source: opening the
    // file here would leak one descriptor per abandoned thumbnail.
    expect(opened).not.toContain(storagePath);
    expect(errors.mock.calls.flat().join("\n")).not.toMatch(/API error|destroyed stream|ERR_STREAM/);
    handled.length = 0;

    const full = await fetchAll(url);
    expect(full.complete).toBe(true);
    expect(digest(full.body)).toBe(digest(content));
  });

  it("a route that fails after writing its headers, with nothing streaming yet, still has its connection cut", async () => {
    const { url, storagePath } = await attachLarge("open fails after headers");
    const errors = vi.spyOn(logger, "error");
    interceptReads(storagePath, () => {
      throw Object.assign(new Error("simulated open failure"), { code: "EMFILE" });
    });

    // Left open, the client would wait forever for the Content-Length it was promised.
    const outcome = await Promise.race([
      new Promise<string>((resolve) => {
        const req = http.get(`${base}${url}`, { headers: operatorHeaders }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.complete ? "complete" : "cut"));
          res.on("error", () => resolve("cut"));
        });
        req.on("error", () => resolve("cut"));
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve("left hanging"), 3000)),
    ]);
    expect(outcome).toBe("cut");
    expect((await settledHandlers()).map((o) => o.status)).toEqual(["fulfilled"]);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/simulated open failure/);
  });
});
