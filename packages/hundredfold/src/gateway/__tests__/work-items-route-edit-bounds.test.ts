import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { api, ctx, makeRawReq, makeRes, operatorHeaders, store } from "./helpers/work-items-route-harness.js";

type ApiRequest = ReturnType<typeof makeRawReq>;
type Target = { id: string; version: number };

const OVERSIZE_TARGET_TITLE = "Oversize edit target";

function makeChunkedRawReq(
  method: string,
  urlPath: string,
  chunks: string[],
  headers: Record<string, string> = {},
  slow = false,
): ApiRequest {
  const source = slow
    ? Readable.from((async function* () {
        for (const chunk of chunks) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield Buffer.from(chunk);
        }
      })())
    : Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  return Object.assign(source, {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as ApiRequest;
}

function sizedTodoPatch(expectedVersion: number, byteLength: number, multibyte: boolean): string {
  const prefix = `{"expectedVersion":${expectedVersion},"body":"`;
  const suffix = '"}';
  let remaining = byteLength - Buffer.byteLength(prefix + suffix);
  if (remaining < 0) throw new Error("requested Todo patch size is smaller than its JSON envelope");
  let body = "";
  if (multibyte) {
    const unit = "ж"; // two UTF-8 bytes; JSON.stringify preserves it verbatim.
    body = unit.repeat(Math.floor(remaining / Buffer.byteLength(unit)));
    remaining -= Buffer.byteLength(body);
  }
  body += "a".repeat(remaining);
  const raw = prefix + body + suffix;
  if (Buffer.byteLength(raw) !== byteLength) throw new Error("Todo patch byte-size fixture drifted");
  return raw;
}

/** Splits an oversized patch into 1 KiB pieces so the bound is crossed mid-stream. */
function kibibyteChunks(raw: string): string[] {
  return Array.from({ length: Math.ceil(raw.length / 1024) }, (_, index) => raw.slice(index * 1024, (index + 1) * 1024));
}

describe("PATCH /api/work-items/:id — request body bounds", () => {
  it.each([
    ["malformed JSON", (target: Target) => makeRawReq("PATCH", `/api/work-items/${target.id}`, "{"), "todo_invalid_patch"],
    [
      "a declared Content-Length over the limit",
      (target: Target) => makeRawReq("PATCH", `/api/work-items/${target.id}`, "{}", { "content-length": String(64 * 1024 + 1) }),
      "todo_edit_too_large",
    ],
    [
      "a streamed body over the limit",
      (target: Target) => makeRawReq("PATCH", `/api/work-items/${target.id}`, "x".repeat(64 * 1024 + 1)),
      "todo_edit_too_large",
    ],
  ] as const)("keeps authorization ahead of %s", async (_name, buildRequest, typedCode) => {
    const item = store.createWorkItem({ title: "Bound auth target" });
    const cap = makeRes();
    await api.handleApiRequest(buildRequest(item), cap.res, ctx);
    expect(cap.status).toBe(403);
    expect(cap.body).not.toMatchObject({ code: typedCode });
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, title: "Bound auth target" });
  });

  it.each([
    ["ASCII limit - 1", -1, false],
    ["ASCII limit", 0, false],
    ["ASCII limit + 1", 1, false],
    ["Unicode limit - 1", -1, true],
    ["Unicode limit", 0, true],
    ["Unicode limit + 1", 1, true],
  ])("enforces the 64 KiB UTF-8 request bound at %s", async (_name, delta, multibyte) => {
    const item = store.createWorkItem({ title: "Bounded edit target" });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const raw = sizedTodoPatch(item.version, 64 * 1024 + delta, multibyte);
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, raw, {
        ...operatorHeaders,
        "content-length": String(Buffer.byteLength(raw)),
      }),
      cap.res,
      ctx,
    );

    if (delta <= 0) {
      expect(cap.status).toBe(200);
      expect(cap.body.workItem.version).toBe(2);
      expect(Buffer.byteLength(cap.body.workItem.body, "utf8")).toBeLessThan(64 * 1024);
    } else {
      expect(cap.status).toBe(413);
      expect(cap.body).toEqual({
        error: "Todo edit request exceeds the 64 KiB limit.",
        code: "todo_edit_too_large",
      });
      expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, body: null });
      expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
    }
  });

  // Whichever way the bytes arrive — declared up front, dribbled in without a
  // Content-Length, or declared as a lie — the limit is enforced before the row
  // or its audit trail moves.
  it.each([
    [
      "an oversized declared Content-Length",
      (target: Target) =>
        makeRawReq("PATCH", `/api/work-items/${target.id}`, '{"expectedVersion":1,"title":"safe"}', {
          ...operatorHeaders,
          "content-length": String(64 * 1024 + 1),
        }),
      { version: 1, title: OVERSIZE_TARGET_TITLE },
    ],
    [
      "a lying short Content-Length",
      (target: Target) =>
        makeChunkedRawReq("PATCH", `/api/work-items/${target.id}`, kibibyteChunks(sizedTodoPatch(target.version, 64 * 1024 + 1, true)), {
          ...operatorHeaders,
          "content-length": "1",
        }),
      { version: 1, body: null },
    ],
    [
      "a chunked body with no Content-Length",
      (target: Target) =>
        makeChunkedRawReq("PATCH", `/api/work-items/${target.id}`, kibibyteChunks(sizedTodoPatch(target.version, 64 * 1024 + 1, true)), operatorHeaders),
      { version: 1, body: null },
    ],
    [
      "a slow streamed body",
      (target: Target) =>
        makeChunkedRawReq(
          "PATCH",
          `/api/work-items/${target.id}`,
          kibibyteChunks(sizedTodoPatch(target.version, 64 * 1024 + 1, true)),
          operatorHeaders,
          true,
        ),
      { version: 1, body: null },
    ],
    [
      "a two-megabyte body",
      (target: Target) =>
        makeRawReq("PATCH", `/api/work-items/${target.id}`, `{"expectedVersion":1,"body":"${"x".repeat(2 * 1024 * 1024)}"}`, operatorHeaders),
      { version: 1, body: null },
    ],
  ] as const)("rejects %s without storing or auditing it", async (_name, buildRequest, unchangedRow) => {
    const item = store.createWorkItem({ title: OVERSIZE_TARGET_TITLE });
    const eventsBefore = store.listWorkItemEvents(item.id).length;
    const cap = makeRes();
    await api.handleApiRequest(buildRequest(item), cap.res, ctx);
    expect(cap.status).toBe(413);
    expect(cap.body).toEqual({ error: "Todo edit request exceeds the 64 KiB limit.", code: "todo_edit_too_large" });
    expect(store.getWorkItem(item.id)).toMatchObject(unchangedRow);
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventsBefore);
  });

  it("rejects compressed Todo edit bodies instead of buffering or decompressing them", async () => {
    const item = store.createWorkItem({ title: "Encoding policy target" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeRawReq("PATCH", `/api/work-items/${item.id}`, '{"expectedVersion":1,"title":"encoded"}', {
        ...operatorHeaders,
        "content-encoding": "gzip",
      }),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    expect(cap.body).toEqual({ error: "Todo edit request must be valid JSON.", code: "todo_invalid_patch" });
    expect(store.getWorkItem(item.id)).toMatchObject({ version: 1, title: "Encoding policy target" });
  });
});
