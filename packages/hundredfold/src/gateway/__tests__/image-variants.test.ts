import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { photoBuffer } from "./image-fixture.js";

type CreateSharp = typeof import("sharp")["default"];

const generations = vi.hoisted(() => ({ count: 0 }));

// Real sharp, wrapped so the suite can see how often generation actually ran.
// The byte assertions need genuine output; the cache assertions need the count.
// The factory is synchronous: with an async one, generations that import sharp
// at the same moment can be handed an empty module.
const real = vi.hoisted(() => {
  const { createRequire } = process.getBuiltinModule("node:module");
  return createRequire(import.meta.url)("sharp") as (...args: unknown[]) => unknown;
});
vi.mock("sharp", () => ({
  default: (...args: Parameters<CreateSharp>) => {
    generations.count += 1;
    return real(...args);
  },
}));

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-image-variants-"));
  roots.push(root);
  return root;
}

let photo: string;
let photoRoot: string;

async function loadVariants() {
  return import("../image-variants.js");
}

beforeAll(async () => {
  photoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-image-fixture-"));
  photo = path.join(photoRoot, "photo.jpg");
  fs.writeFileSync(photo, await photoBuffer());
});

afterAll(() => fs.rmSync(photoRoot, { recursive: true, force: true }));

beforeEach(() => {
  vi.resetModules();
  generations.count = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("image variants", () => {
  it("generates a much smaller thumbnail once and serves the cached file afterwards", async () => {
    const variants = await loadVariants();

    const first = await variants.ensureThumbnail(photo, "cached-photo");
    expect(first).toMatch(/thumb\.webp$/);
    expect(generations.count).toBe(1);

    const original = fs.statSync(photo).size;
    const thumbnail = fs.statSync(first!).size;
    expect(thumbnail).toBeLessThan(original * 0.1);

    const second = await variants.ensureThumbnail(photo, "cached-photo");
    expect(second).toBe(first);
    expect(generations.count).toBe(1);
  });

  it("deduplicates concurrent requests for the same thumbnail", async () => {
    const variants = await loadVariants();

    const [left, right] = await Promise.all([
      variants.ensureThumbnail(photo, "concurrent-photo"),
      variants.ensureThumbnail(photo, "concurrent-photo"),
    ]);

    expect(left).toMatch(/thumb\.webp$/);
    expect(right).toBe(left);
    expect(generations.count).toBe(1);
  });

  describe("a client that leaves while its thumbnail is queued", () => {
    /** Whether a thumbnail for this key reached the cache. */
    async function cached(key: string): Promise<boolean> {
      const { IMAGE_CACHE_DIR } = await import("../../shared/paths.js");
      const digest = crypto.createHash("sha256").update(key).digest("hex");
      return fs.existsSync(path.join(IMAGE_CACHE_DIR, digest, "thumb.webp"));
    }

    it("is not generated for, and a later request still can", async () => {
      const variants = await loadVariants();

      // Two slots are taken at once, so the third request waits its turn.
      let gone = false;
      const results = await Promise.all([
        variants.ensureThumbnail(photo, "busy-one"),
        variants.ensureThumbnail(photo, "busy-two"),
        variants.ensureThumbnail(photo, "left-while-queued", () => !gone),
        Promise.resolve().then(() => {
          gone = true;
        }),
      ]);
      expect(results[0]).toMatch(/thumb\.webp$/);
      expect(results[1]).toMatch(/thumb\.webp$/);
      expect(results[2]).toBeNull();
      expect(await cached("left-while-queued")).toBe(false);

      // Skipping is not a failure: the next request for it is generated normally.
      await expect(variants.ensureThumbnail(photo, "left-while-queued")).resolves.toMatch(/thumb\.webp$/);
      expect(await cached("left-while-queued")).toBe(true);
    });

    it("is not generated for when the attachment route asks for it and the client leaves", async () => {
      const variants = await loadVariants();
      const { selectAttachmentVariant } = await import("../attachment-variants.js");
      const attachment = {
        storagePath: photo,
        mime: "image/jpeg",
        filename: "photo.jpg",
        sha256: "route-left-while-queued",
      } as import("../../work-items/attachments.js").WorkItemAttachment;

      let gone = false;
      const [, , selected] = await Promise.all([
        variants.ensureThumbnail(photo, "busy-five"),
        variants.ensureThumbnail(photo, "busy-six"),
        selectAttachmentVariant(attachment, new URLSearchParams("thumb=1"), false, () => !gone),
        Promise.resolve().then(() => {
          gone = true;
        }),
      ]);
      // Nothing was made, so what comes back is the original, uncached.
      expect(selected).toMatchObject({ variant: "original", isFallback: true });
      expect(await cached("todo:route-left-while-queued")).toBe(false);
    });

    it("is still generated when another request for the same thumbnail waits on it", async () => {
      const variants = await loadVariants();

      let gone = false;
      const [, , leaver, stayer] = await Promise.all([
        variants.ensureThumbnail(photo, "busy-three"),
        variants.ensureThumbnail(photo, "busy-four"),
        variants.ensureThumbnail(photo, "shared", () => !gone),
        variants.ensureThumbnail(photo, "shared"),
        Promise.resolve().then(() => {
          gone = true;
        }),
      ]);
      expect(leaver).toMatch(/thumb\.webp$/);
      expect(stayer).toBe(leaver);
      expect(await cached("shared")).toBe(true);
    });
  });

  it("memoises an unreadable image instead of retrying it on every request", async () => {
    const source = path.join(makeRoot(), "corrupt.jpg");
    fs.writeFileSync(source, Buffer.alloc(2048, 9));
    const logger = await import("../../shared/logger.js");
    const warn = vi.spyOn(logger.logger, "warn").mockImplementation(() => {});
    const variants = await loadVariants();

    await expect(variants.ensureThumbnail(source, "corrupt-photo")).resolves.toBeNull();
    expect(generations.count).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(variants.ensureThumbnail(source, "corrupt-photo")).resolves.toBeNull();
    expect(generations.count).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
