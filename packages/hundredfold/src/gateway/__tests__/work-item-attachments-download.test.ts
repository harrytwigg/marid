import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { call, operatorHeaders, store, tmp, upload } from "./helpers/work-item-attachments-harness.js";
import { photoBuffer } from "./image-fixture.js";

/**
 * Route-level tests for reading an attachment back: the plain stream, byte
 * ranges, the cached video and image variants, the integrity guard, and the
 * 404 lanes. Drives handleApiRequest directly against a throwaway HUNDREDFOLD_HOME.
 */

describe("GET /api/work-items/:id/attachments/:aid (download)", () => {
  it("streams the bytes with the stored mime and a filename Content-Disposition", async () => {
    const item = store.createWorkItem({ title: "download" });
    const content = Buffer.from("download me");
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "report.pdf", content } }, operatorHeaders);
    const id = posted.body.attachment.id;
    const got = await call("GET", `/api/work-items/${item.id}/attachments/${id}`, undefined, operatorHeaders);
    expect(got.status).toBe(200);
    expect(got.headers["Accept-Ranges"]).toBe("bytes");
    expect(got.headers["Content-Type"]).toBe("application/pdf");
    expect(String(got.headers["Content-Disposition"])).toBe('attachment; filename="report.pdf"');
    expect(got.raw).toEqual(content);
  });

  it("returns 304 when If-None-Match weakly matches the attachment ETag", async () => {
    const item = store.createWorkItem({ title: "conditional download" });
    const content = Buffer.from("cache me");
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "cache.txt", content } }, operatorHeaders);
    const url = `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}`;

    const initial = await call("GET", url, undefined, operatorHeaders);
    expect(initial.status).toBe(200);
    expect(initial.raw).toEqual(content);
    const etag = String(initial.headers.ETag);

    const stale = await call("GET", url, undefined, { ...operatorHeaders, "if-none-match": '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.raw).toEqual(content);

    const fresh = await call("GET", url, undefined, { ...operatorHeaders, "if-none-match": `W/"stale", W/${etag}` });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.ETag).toBe(etag);
    expect(fresh.raw).toHaveLength(0);
  });

  it("streams an exact byte range and returns 416 when the range cannot be satisfied", async () => {
    const item = store.createWorkItem({ title: "ranged download" });
    const content = Buffer.from("0123456789");
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "clip.mp4", content } }, operatorHeaders);
    const url = `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}`;

    const partial = await call("GET", url, undefined, { ...operatorHeaders, range: "bytes=3-6" });
    expect(partial.status).toBe(206);
    expect(partial.headers["Content-Range"]).toBe("bytes 3-6/10");
    expect(partial.headers["Accept-Ranges"]).toBe("bytes");
    expect(partial.raw).toEqual(Buffer.from("3456"));

    const impossible = await call("GET", url, undefined, { ...operatorHeaders, range: "bytes=10-" });
    expect(impossible.status).toBe(416);
    expect(impossible.headers["Content-Range"]).toBe("bytes */10");
  });

  it("serves a cached low video variant while download always returns the original", async () => {
    const item = store.createWorkItem({ title: "quality download" });
    const original = Buffer.alloc(1024, 5);
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "quality.mp4", content: original } }, operatorHeaders);
    const attachment = posted.body.attachment;
    const url = `/api/work-items/${item.id}/attachments/${attachment.id}`;

    const fallback = await call("GET", `${url}?quality=low`, undefined, operatorHeaders);
    expect(fallback.raw).toEqual(original);
    expect(fallback.headers["Cache-Control"]).toBe("no-store");

    const cacheDir = path.join(tmp, "cache", "video", createHash("sha256").update(`todo:${attachment.sha256}`).digest("hex"));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "low.mp4"), Buffer.from("low"));

    const low = await call("GET", `${url}?quality=low`, undefined, operatorHeaders);
    expect(low.status).toBe(200);
    expect(low.raw).toEqual(Buffer.from("low"));
    expect(Number(low.headers["Content-Length"])).toBeLessThan(original.length);

    const download = await call("GET", `${url}?quality=low&download=1`, undefined, operatorHeaders);
    expect(download.headers["Content-Disposition"]).toBe('attachment; filename="quality.mp4"');
    expect(download.raw).toEqual(original);
  });

  it("serves a much smaller image thumbnail while the plain and download URLs keep the original", async () => {
    const original = await photoBuffer();
    const source = path.join(tmp, "thumbnail-photo.jpg");
    fs.writeFileSync(source, original);

    const item = store.createWorkItem({ title: "thumbnail" });
    const posted = await call("POST", `/api/work-items/${item.id}/attachments`, { path: source }, operatorHeaders);
    const attachment = posted.body.attachment;
    const url = `/api/work-items/${item.id}/attachments/${attachment.id}`;

    const thumb = await call("GET", `${url}?thumb=1`, undefined, operatorHeaders);
    expect(thumb.status).toBe(200);
    expect(thumb.headers["Content-Type"]).toBe("image/webp");
    expect(thumb.raw.length).toBeLessThan(original.length * 0.1);
    expect(thumb.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(String(thumb.headers["ETag"])).toContain("-thumb-");

    // Hashes, not toEqual: a deep-equal over two megabyte Buffers costs seconds.
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const plain = await call("GET", url, undefined, operatorHeaders);
    expect(digest(plain.raw)).toBe(attachment.sha256);
    const download = await call("GET", `${url}?thumb=1&download=1`, undefined, operatorHeaders);
    expect(digest(download.raw)).toBe(attachment.sha256);
    expect(download.headers["Content-Disposition"]).toBe('attachment; filename="thumbnail-photo.jpg"');
  });

  it("returns the original uncached when an image thumbnail cannot be generated", async () => {
    const item = store.createWorkItem({ title: "thumbnail fallback" });
    const original = Buffer.from("not really a PNG");
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "broken.png", content: original } }, operatorHeaders);
    const url = `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}`;

    for (const attempt of [1, 2]) {
      const got = await call("GET", `${url}?thumb=1`, undefined, operatorHeaders);
      expect(got.status, `attempt ${attempt}`).toBe(200);
      expect(got.raw).toEqual(original);
      expect(got.headers["Cache-Control"]).toBe("no-store");
    }
  });

  it("never rasterises an SVG asked for as a thumbnail", async () => {
    const item = store.createWorkItem({ title: "vector thumbnail" });
    const original = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "logo.svg", content: original } }, operatorHeaders);
    expect(posted.body.attachment.mime).toBe("image/svg+xml");
    const url = `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}`;

    const got = await call("GET", `${url}?thumb=1`, undefined, operatorHeaders);
    expect(got.status).toBe(200);
    expect(got.raw).toEqual(original);
    expect(got.headers["Content-Type"]).toBe("image/svg+xml");
  });

  it("rejects a stored size mismatch loudly", async () => {
    const item = store.createWorkItem({ title: "integrity" });
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "gold.txt", content: Buffer.from("golden bytes") } }, operatorHeaders);
    const attachment = posted.body.attachment;
    fs.writeFileSync(attachment.storagePath, "tampered");
    const got = await call("GET", `/api/work-items/${item.id}/attachments/${attachment.id}`, undefined, operatorHeaders);
    expect(got.status).toBe(500);
    expect(got.body.error).toMatch(/size/);
  });

  it("a same-content re-upload restores availability after blob corruption — download succeeds again (review F4)", async () => {
    const item = store.createWorkItem({ title: "repair download" });
    const content = Buffer.from("blob to break and repair");
    const first = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "heal.txt", content } }, operatorHeaders);
    fs.writeFileSync(first.body.attachment.storagePath, "broken");
    const broken = await call("GET", `/api/work-items/${item.id}/attachments/${first.body.attachment.id}`, undefined, operatorHeaders);
    expect(broken.status).toBe(500);

    const again = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "heal2.txt", content } }, operatorHeaders);
    expect(again.status).toBe(201);
    const restored = await call("GET", `/api/work-items/${item.id}/attachments/${first.body.attachment.id}`, undefined, operatorHeaders);
    expect(restored.status).toBe(200);
    expect(restored.raw).toEqual(content);
  });

  it("404s a wrong-item path and an unknown id", async () => {
    const a = store.createWorkItem({ title: "wrong path a" });
    const b = store.createWorkItem({ title: "wrong path b" });
    const posted = await upload(`/api/work-items/${a.id}/attachments`, { file: { name: "a.txt", content: Buffer.from("a") } }, operatorHeaders);
    const id = posted.body.attachment.id;
    expect((await call("GET", `/api/work-items/${b.id}/attachments/${id}`, undefined, operatorHeaders)).status).toBe(404);
    expect((await call("GET", `/api/work-items/${a.id}/attachments/wia_000000000000`, undefined, operatorHeaders)).status).toBe(404);
  });
});
