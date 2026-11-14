import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-imgdim-fail-"));
process.env.HUNDREDFOLD_HOME = tmp;

// sharp is a native module, so "it did not load" and "it could not read this" are
// both live outcomes in the field. An upload that lost its dimensions to either
// is still an upload the caller must get back.
vi.mock("sharp", () => ({
  default: () => ({ metadata: () => Promise.reject(new Error("probe exploded")) }),
}));

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type ImageDimensions = typeof import("../image-dimensions.js");

let files: Files;
let reg: Reg;
let imageDimensions: ImageDimensions;
let logger: typeof import("../../shared/logger.js").logger;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  imageDimensions = await import("../image-dimensions.js");
  logger = (await import("../../shared/logger.js")).logger;
  (await import("../../shared/db.js")).initDb();
});

const ctx = { emit: () => {}, getConfig: () => ({}) } as unknown as import("../api.js").ApiContext;

describe("a failing dimension probe", () => {
  it("gives up the dimensions and says so at the level its neighbour does", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await imageDimensions.readImageDimensions(Buffer.from("anything"))).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("probe exploded"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not cost the caller their upload", async () => {
    const body = JSON.stringify({ filename: "photo.png", content: Buffer.from("PNGDATA").toString("base64") });
    const req = Readable.from([Buffer.from(body)]) as unknown as import("node:http").IncomingMessage;
    (req as unknown as { headers: Record<string, string> }).headers = { "content-type": "application/json" };
    const out: { status?: number; body?: string } = {};
    const res = {
      writeHead(status: number) { out.status = status; return res; },
      end(chunk?: string) { out.body = chunk; return res; },
    } as unknown as import("node:http").ServerResponse;

    await files.handleFilesRequest(req, res, {
      method: "POST",
      pathname: "/api/files",
      url: new URL("/api/files", "http://localhost"),
    }, ctx);

    expect(out.status).toBe(201);
    const uploaded = JSON.parse(out.body!) as { id: string };
    const stored = reg.getFile(uploaded.id) as unknown as Record<string, unknown>;
    expect(stored).toMatchObject({ filename: "photo.png" });
    expect("width" in stored).toBe(false);
    expect("height" in stored).toBe(false);
  });
});
