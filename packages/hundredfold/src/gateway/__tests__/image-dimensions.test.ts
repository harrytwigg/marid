import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { photoBuffer } from "./image-fixture.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-imgdim-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type ImageDimensions = typeof import("../image-dimensions.js");

let files: Files;
let reg: Reg;
let imageDimensions: ImageDimensions;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  imageDimensions = await import("../image-dimensions.js");
  (await import("../../shared/db.js")).initDb();
});

/** A PNG of an exact shape — its dimensions are the only thing under test. */
async function pngBuffer(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.alloc(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** The quarter turn a phone camera records in EXIF instead of rotating pixels. */
async function sidewaysPhotoBuffer(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(await photoBuffer(width, height)).withMetadata({ orientation: 6 }).toBuffer();
}

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { out.body = body; return res; },
  } as unknown as import("node:http").ServerResponse;
  return { res, out };
}

const ctx = { emit: () => {}, getConfig: () => ({}) } as unknown as import("../api.js").ApiContext;

function route(method: string, pathname: string): import("../route-helpers.js").ParsedRoute {
  return { method, pathname, url: new URL(pathname, "http://localhost") };
}

/** POST /api/files with a base64 body — the same saveFile path a multipart upload takes. */
async function upload(filename: string, bytes: Buffer): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ filename, content: bytes.toString("base64") });
  const req = Readable.from([Buffer.from(body)]) as unknown as import("node:http").IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = { "content-type": "application/json" };
  const { res, out } = fakeRes();
  await files.handleFilesRequest(req, res, route("POST", "/api/files"), ctx);
  expect(out.status).toBe(201);
  return JSON.parse(out.body!) as Record<string, unknown>;
}

async function readMeta(id: string): Promise<Record<string, unknown>> {
  const { res, out } = fakeRes();
  const req = { headers: {} } as unknown as import("node:http").IncomingMessage;
  await files.handleFilesRequest(req, res, route("GET", `/api/files/${id}/meta`), ctx);
  return JSON.parse(out.body!) as Record<string, unknown>;
}

/** Neither side is there at all — not null, not zero, not present-and-empty. */
function expectNoDimensions(subject: object): void {
  expect("width" in subject).toBe(false);
  expect("height" in subject).toBe(false);
}

describe("readImageDimensions", () => {
  it("reads the size of a portrait image", async () => {
    expect(await imageDimensions.readImageDimensions(await pngBuffer(600, 1200))).toEqual({ width: 600, height: 1200 });
  });

  it("reports what a rotated photo displays as, not what it stores", async () => {
    const sharp = (await import("sharp")).default;
    const sideways = await sidewaysPhotoBuffer(400, 200);

    // The stored pixels are landscape and the EXIF quarter-turn makes it portrait;
    // recording the stored shape would reserve a landscape box for a tall picture.
    const stored = await sharp(sideways).metadata();
    expect([stored.width, stored.height]).toEqual([400, 200]);

    expect(await imageDimensions.readImageDimensions(sideways)).toEqual({ width: 200, height: 400 });
  });

  it("returns null for bytes no decoder recognises", async () => {
    expect(await imageDimensions.readImageDimensions(Buffer.from("not an image"))).toBeNull();
  });
});

describe("upload dimensions", () => {
  it("records a portrait PNG's size on its row, its meta route, and its media descriptor", async () => {
    const uploaded = await upload("portrait.png", await pngBuffer(600, 1200));
    const id = uploaded.id as string;

    expect(reg.getFile(id)).toMatchObject({ width: 600, height: 1200 });
    expect(await readMeta(id)).toMatchObject({ width: 600, height: 1200 });
    expect(files.fileIdsToMedia([id])[0]).toMatchObject({ type: "image", width: 600, height: 1200 });
  });

  it("stores a non-image without dimensions rather than with empty ones", async () => {
    const uploaded = await upload("bundle.zip", Buffer.from("PKzipdata"));
    const id = uploaded.id as string;

    // Absent everywhere, not null: the client reserves a box only when it has both
    // sides, and a null pair would be a second way of saying "unknown" for every
    // reader of the row, the upload response, the meta route and the descriptor.
    expectNoDimensions(uploaded);
    expectNoDimensions(reg.getFile(id)!);
    expectNoDimensions(await readMeta(id));
    expectNoDimensions(files.fileIdsToMedia([id])[0]);
  });

  it("stores an image whose bytes are corrupt without dimensions, and still succeeds", async () => {
    const uploaded = await upload("broken.png", Buffer.from("this is not really a PNG"));
    const id = uploaded.id as string;

    expect(reg.getFile(id)).toMatchObject({ mimetype: "image/png" });
    expectNoDimensions(uploaded);
    expectNoDimensions(reg.getFile(id)!);
    expectNoDimensions(await readMeta(id));
    expectNoDimensions(files.fileIdsToMedia([id])[0]);
  });
});
