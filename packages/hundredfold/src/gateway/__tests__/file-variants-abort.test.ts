import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-file-variants-abort-"));
process.env.HUNDREDFOLD_HOME = tmp;

// Count the generators without running them: ffmpeg is not what is under test.
const variants = vi.hoisted(() => ({ poster: vi.fn(async () => null as string | null), low: vi.fn(() => null as string | null) }));
vi.mock("../video-variants.js", () => ({
  ensurePoster: variants.poster,
  ensureLowVariant: variants.low,
}));

type Files = typeof import("../files.js");
let files: Files;
let reg: typeof import("../../sessions/registry.js");
let paths: typeof import("../../shared/paths.js");

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  (await import("../../shared/db.js")).initDb();
  const dir = path.join(paths.FILES_DIR, "leftvideo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "clip.mp4"), Buffer.alloc(1024, 7));
  reg.insertFile({ id: "leftvideo", filename: "clip.mp4", size: 1024, mimetype: "video/mp4", path: null });
});

afterEach(() => {
  variants.poster.mockClear();
  variants.low.mockClear();
});

class Response extends Writable {
  statusCode = 0;
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }
}

async function request(query: string, clientLeaves: boolean): Promise<Response> {
  const res = new Response();
  if (clientLeaves) res.destroy();
  await files.handleFilesRequest(
    { method: "GET", url: `/api/files/leftvideo${query}`, headers: {} } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    { method: "GET", pathname: "/api/files/leftvideo", url: new URL(`/api/files/leftvideo${query}`, "http://localhost") },
    { emit: () => {} } as unknown as import("../api.js").ApiContext,
  );
  return res;
}

describe("GET /api/files/:id for a client that has already left", () => {
  it("generates neither a poster nor a low variant", async () => {
    for (const query of ["?poster=1", "?quality=low"]) {
      const res = await request(query, true);
      expect(res.statusCode, query).toBe(0);
    }
    expect(variants.poster).not.toHaveBeenCalled();
    expect(variants.low).not.toHaveBeenCalled();
  });

  it("still asks for them while the client is there", async () => {
    await request("?poster=1", false);
    await request("?quality=low", false);
    expect(variants.poster).toHaveBeenCalledTimes(1);
    expect(variants.low).toHaveBeenCalledTimes(1);
  });
});
