import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  api,
  attachments,
  call,
  comments,
  ctx,
  emittedEvents,
  makeRes,
  operatorHeaders,
  reg,
  store,
  tmp,
  toolHeaders,
  upload,
} from "./helpers/work-item-attachments-harness.js";
import type { ApiRequest } from "./helpers/work-item-attachments-harness.js";

/**
 * Route-level tests for Todos v2 slice 5: attachment upload (multipart + JSON
 * path), list, removal authority, the departments surface, and the label-PUT
 * array cap. Reading an attachment back lives in
 * work-item-attachments-download.test.ts. Drives handleApiRequest directly
 * against a throwaway JINN_HOME.
 */

describe("POST /api/work-items/:id/attachments (multipart)", () => {
  it("uploads a file with sniffed mime and server-stamped uploader, and appears in the list", async () => {
    const item = store.createWorkItem({ title: "upload host" });
    const content = Buffer.from("route upload bytes");
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "shot.png", content } }, operatorHeaders);
    expect(posted.status).toBe(201);
    const attachment = posted.body.attachment;
    expect(attachment.id).toMatch(/^wia_[0-9a-f]{12}$/);
    expect(attachment.filename).toBe("shot.png");
    expect(attachment.mime).toBe("image/png"); // sniffed from the extension
    expect(attachment.bytes).toBe(content.length);
    expect(attachment.uploadedBy).toBe("operator");
    expect(attachment.commentId).toBeNull();
    expect(path.isAbsolute(attachment.storagePath)).toBe(true);

    const listed = await call("GET", `/api/work-items/${item.id}/attachments`, undefined, operatorHeaders);
    expect(listed.status).toBe(200);
    expect(listed.body.attachments.map((a: { id: string }) => a.id)).toEqual([attachment.id]);
  });

  it("attaches to a comment via the commentId field; a foreign comment is 403", async () => {
    const item = store.createWorkItem({ title: "comment target" });
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "att-worker", employee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "att-stranger", employee: "solo-worker" });
    const comment = comments.addComment({ workItemId: item.id, body: "worker's comment", author: "platform-worker", authorKind: "employee" });

    const denied = await upload(
      `/api/work-items/${item.id}/attachments`,
      { file: { name: "steal.txt", content: Buffer.from("x") }, fields: { commentId: comment.id } },
      toolHeaders(stranger.id),
    );
    expect(denied.status).toBe(403);

    const posted = await upload(
      `/api/work-items/${item.id}/attachments`,
      { file: { name: "mine.txt", content: Buffer.from("worker bytes") }, fields: { commentId: comment.id } },
      toolHeaders(worker.id),
    );
    expect(posted.status).toBe(201);
    expect(posted.body.attachment.commentId).toBe(comment.id);
    expect(posted.body.attachment.uploadedBy).toBe("platform-worker");
  });

  it("maps comment failures: unknown/cross-item comment 404, tombstoned comment 409", async () => {
    const a = store.createWorkItem({ title: "map a" });
    const b = store.createWorkItem({ title: "map b" });
    const onB = comments.addComment({ workItemId: b.id, body: "on b", author: "operator", authorKind: "operator" });
    const gone = comments.addComment({ workItemId: a.id, body: "going", author: "operator", authorKind: "operator" });
    comments.tombstoneComment(gone.id, { author: "operator", authorKind: "operator", operator: true });

    const cross = await upload(
      `/api/work-items/${a.id}/attachments`,
      { file: { name: "x.txt", content: Buffer.from("x") }, fields: { commentId: onB.id } },
      operatorHeaders,
    );
    expect(cross.status).toBe(404);

    const unknown = await upload(
      `/api/work-items/${a.id}/attachments`,
      { file: { name: "x.txt", content: Buffer.from("x") }, fields: { commentId: "wic_000000000000" } },
      operatorHeaders,
    );
    expect(unknown.status).toBe(404);

    const deleted = await upload(
      `/api/work-items/${a.id}/attachments`,
      { file: { name: "x.txt", content: Buffer.from("x") }, fields: { commentId: gone.id } },
      operatorHeaders,
    );
    expect(deleted.status).toBe(409);
  });

  it("rejects an oversize multipart upload with 413 and stores nothing", async () => {
    const item = store.createWorkItem({ title: "oversize" });
    const over = Buffer.alloc(attachments.ATTACHMENT_MAX_BYTES + 1, 3);
    const posted = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "big.bin", content: over } }, operatorHeaders);
    expect(posted.status).toBe(413);
    expect(attachments.listAttachments(item.id)).toHaveLength(0);
  });

  it("rejects anonymous and file-less uploads", async () => {
    const item = store.createWorkItem({ title: "anon" });
    const anon = await upload(`/api/work-items/${item.id}/attachments`, { file: { name: "x.txt", content: Buffer.from("x") } });
    expect(anon.status).toBe(403);
    const empty = await upload(`/api/work-items/${item.id}/attachments`, { fields: { commentId: "" } }, operatorHeaders);
    expect(empty.status).toBe(400);
  });
});

describe("POST /api/work-items/:id/attachments — multipart hardening (review F3)", () => {
  const boundary = "----jinnHardeningBoundary";

  function rawPart(name: string, filename: string | null, content: Buffer | string): Buffer {
    const disposition = filename === null
      ? `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    return Buffer.concat([Buffer.from(`--${boundary}\r\n${disposition}`), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from("\r\n")]);
  }

  async function rawUpload(urlPath: string, parts: Buffer[], headers: Record<string, string> = {}, contentLength?: number) {
    const body = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
    const req = Object.assign(Readable.from([body]), {
      method: "POST",
      url: urlPath,
      headers: {
        host: "localhost",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(contentLength ?? body.length),
        ...headers,
      },
    }) as unknown as ApiRequest;
    const cap = makeRes();
    await api.handleApiRequest(req, cap.res, ctx);
    return cap;
  }

  it("refuses a second file part early — exactly one file field, nothing stored (multi-file regression)", async () => {
    const item = store.createWorkItem({ title: "multi-file" });
    const got = await rawUpload(`/api/work-items/${item.id}/attachments`, [
      rawPart("file", "one.bin", Buffer.alloc(1024 * 1024, 1)),
      rawPart("file", "two.bin", "second part"),
    ], operatorHeaders);
    expect(got.status).toBe(400);
    expect(String(got.body.error)).toMatch(/one file/i);
    expect(attachments.listAttachments(item.id)).toHaveLength(0);
  });

  it('refuses a file part not named "file"', async () => {
    const item = store.createWorkItem({ title: "wrong field" });
    const got = await rawUpload(`/api/work-items/${item.id}/attachments`, [
      rawPart("payload", "sneaky.bin", "x"),
    ], operatorHeaders);
    expect(got.status).toBe(400);
    expect(String(got.body.error)).toMatch(/"file"/);
    expect(attachments.listAttachments(item.id)).toHaveLength(0);
  });

  it("refuses excess non-file fields and oversized field values", async () => {
    const item = store.createWorkItem({ title: "field limits" });
    const many = Array.from({ length: 8 }, (_, i) => rawPart(`field-${i}`, null, "v"));
    const excess = await rawUpload(`/api/work-items/${item.id}/attachments`, [...many, rawPart("file", "a.txt", "a")], operatorHeaders);
    expect(excess.status).toBe(400);

    const fat = await rawUpload(`/api/work-items/${item.id}/attachments`, [
      rawPart("commentId", null, "x".repeat(64 * 1024)),
      rawPart("file", "a.txt", "a"),
    ], operatorHeaders);
    expect(fat.status).toBe(400);
    expect(attachments.listAttachments(item.id)).toHaveLength(0);
  });

  it("enforces an aggregate request-byte ceiling up front", async () => {
    const item = store.createWorkItem({ title: "aggregate ceiling" });
    const got = await rawUpload(
      `/api/work-items/${item.id}/attachments`,
      [rawPart("file", "small.txt", "tiny")],
      operatorHeaders,
      attachments.ATTACHMENT_MAX_BYTES + 10 * 1024 * 1024, // declared way beyond the ceiling
    );
    expect(got.status).toBe(413);
    expect(attachments.listAttachments(item.id)).toHaveLength(0);
  });
});

describe("POST /api/work-items/:id/attachments (JSON path)", () => {
  it("ingests a local file by path — filename defaults to the basename, mime sniffed", async () => {
    const item = store.createWorkItem({ title: "json path" });
    const source = path.join(tmp, "screenshot.jpeg");
    fs.writeFileSync(source, "jpeg-ish bytes");
    const posted = await call("POST", `/api/work-items/${item.id}/attachments`, { path: source }, operatorHeaders);
    expect(posted.status).toBe(201);
    expect(posted.body.attachment.filename).toBe("screenshot.jpeg");
    expect(posted.body.attachment.mime).toBe("image/jpeg");
    expect(posted.body.attachment.sha256).toBe(createHash("sha256").update("jpeg-ish bytes").digest("hex"));
    // The SOURCE file is copied, never consumed.
    expect(fs.existsSync(source)).toBe(true);
  });

  it("gates the source through assessFileRead: a benign file passes for a capability-bound session, secrets and symlinks-to-secrets are refused (review F1)", async () => {
    const item = store.createWorkItem({ title: "policy gate" });
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "f1-worker", employee: "platform-worker" });

    // A benign local file is the locked MCP contract — allowed for a session.
    const benign = path.join(tmp, "benign-note.txt");
    fs.writeFileSync(benign, "benign bytes");
    const ok = await call("POST", `/api/work-items/${item.id}/attachments`, { path: benign }, toolHeaders(worker.id));
    expect(ok.status).toBe(201);
    expect(ok.body.attachment.uploadedBy).toBe("platform-worker");

    // A direct Jinn-secrets path is refused by the existing read policy.
    const secretsDir = path.join(tmp, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const secret = path.join(secretsDir, "api-keys.json");
    fs.writeFileSync(secret, "{}");
    const direct = await call("POST", `/api/work-items/${item.id}/attachments`, { path: secret }, toolHeaders(worker.id));
    expect(direct.status).toBe(403);
    expect(String(direct.body.error)).toMatch(/secret/i);

    // A symlink pointing into secrets is canonicalized and refused too.
    const link = path.join(tmp, "innocent-looking.json");
    fs.symlinkSync(secret, link);
    const viaLink = await call("POST", `/api/work-items/${item.id}/attachments`, { path: link }, toolHeaders(worker.id));
    expect(viaLink.status).toBe(403);

    // Nothing from the refused sources reached the store.
    expect(attachments.listAttachments(item.id).map((a) => a.filename)).toEqual(["benign-note.txt"]);
  });

  it("404s an unknown source path and 400s a missing one", async () => {
    const item = store.createWorkItem({ title: "json path bad" });
    const missing = await call("POST", `/api/work-items/${item.id}/attachments`, { path: path.join(tmp, "nope.txt") }, operatorHeaders);
    expect(missing.status).toBe(404);
    const empty = await call("POST", `/api/work-items/${item.id}/attachments`, {}, operatorHeaders);
    expect(empty.status).toBe(400);
  });
});

describe("DELETE /api/work-items/:id/attachments/:aid", () => {
  it("uploader-or-operator: a stranger is 403, the uploader removes, double-delete 404s", async () => {
    const item = store.createWorkItem({ title: "delete authority" });
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "del-worker", employee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "del-stranger", employee: "solo-worker" });
    const posted = await upload(
      `/api/work-items/${item.id}/attachments`,
      { file: { name: "workers.txt", content: Buffer.from("worker upload") } },
      toolHeaders(worker.id),
    );
    expect(posted.status).toBe(201);
    const id = posted.body.attachment.id;

    expect((await call("DELETE", `/api/work-items/${item.id}/attachments/${id}`, undefined, toolHeaders(stranger.id))).status).toBe(403);
    const removed = await call("DELETE", `/api/work-items/${item.id}/attachments/${id}`, undefined, toolHeaders(worker.id));
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);
    expect((await call("DELETE", `/api/work-items/${item.id}/attachments/${id}`, undefined, operatorHeaders)).status).toBe(404);
  });
});

describe("GET /api/departments", () => {
  it("lists registered departments with prefixes and live Todo counts", async () => {
    store.createWorkItem({ title: "dept 1", department: "aviation" });
    store.createWorkItem({ title: "dept 2", department: "aviation" });
    store.createWorkItem({ title: "dept 3", department: "biology" });
    const got = await call("GET", "/api/departments", undefined, operatorHeaders);
    expect(got.status).toBe(200);
    const bySlug = new Map(
      (got.body.departments as Array<{ slug: string; prefix: string; createdAt: string; todoCount: number }>).map((d) => [d.slug, d]),
    );
    expect(bySlug.get("aviation")).toMatchObject({ prefix: "AVI", todoCount: 2 });
    expect(bySlug.get("biology")?.todoCount).toBe(1);
    expect(typeof bySlug.get("aviation")?.createdAt).toBe("string");
  });
});

describe("PUT /api/work-items/:id/labels — array cap (HTTP parity with MCP)", () => {
  it("refuses more than 100 entries with a 400", async () => {
    const item = store.createWorkItem({ title: "label cap" });
    const labels = Array.from({ length: 101 }, (_, i) => `label-${i}`);
    const got = await call("PUT", `/api/work-items/${item.id}/labels`, { labels }, operatorHeaders);
    expect(got.status).toBe(400);
    expect(got.body.error).toMatch(/100/);
  });
});

describe("attachment writes emit company:changed for the parent Todo", () => {
  it("upload and delete each emit one entity=todo event; a refused upload emits nothing", async () => {
    const item = store.createWorkItem({ title: "live attachment item" });

    emittedEvents.length = 0;
    const posted = await upload(
      `/api/work-items/${item.id}/attachments`,
      { file: { name: "live.txt", content: Buffer.from("live bytes") } },
      operatorHeaders,
    );
    expect(posted.status).toBe(201);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "attachment-added", id: item.id }),
    }));

    emittedEvents.length = 0;
    const removed = await call(
      "DELETE",
      `/api/work-items/${item.id}/attachments/${posted.body.attachment.id}`,
      undefined,
      operatorHeaders,
    );
    expect(removed.status).toBe(200);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "attachment-removed", id: item.id }),
    }));

    emittedEvents.length = 0;
    const refused = await upload(`/api/work-items/${item.id}/attachments`, {}, operatorHeaders);
    expect(refused.status).toBe(400);
    expect(emittedEvents).toEqual([]);
  });
});
