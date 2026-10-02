import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sfr-")));
process.env.JINN_HOME = tmp;

const remoteRead = vi.fn();
vi.mock("../../engines/remote-file-read.js", () => ({ readRemoteSessionFile: (...args: unknown[]) => remoteRead(...args) }));

const employees = new Map<string, Record<string, unknown>>();
vi.mock("../org-registry.js", () => ({ orgRegistry: () => employees }));

type Handler = typeof import("../session-file-read.js");
let handler: Handler;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sfr-outside-")));

beforeAll(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  const insert = db.prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity, employee) VALUES (?, 'claude', 'web', ?, 'idle', 't', 't', ?)",
  );
  insert.run("local-1", "web:local-1", "local-dev");
  insert.run("remote-1", "web:remote-1", "remote-dev");
  handler = await import("../session-file-read.js");

  fs.writeFileSync(path.join(outside, "report.md"), "# Report\n");
  fs.writeFileSync(path.join(outside, "shot.png"), PNG);
  fs.writeFileSync(path.join(outside, "diagram.svg"), "<svg onload=\"alert(1)\"/>");
  fs.writeFileSync(path.join(outside, "blob.txt"), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(tmp, "notes.txt"), "relative to home\n");
  fs.writeFileSync(path.join(outside, "run.sh"), "#!/bin/sh\nexport API_TOKEN=abc123secret\necho ok\n");
  fs.writeFileSync(path.join(outside, "Dockerfile"), "FROM node:24\n");
  fs.writeFileSync(path.join(outside, "main.py"), "print('hi')\n");
  fs.writeFileSync(path.join(outside, "fix.patch"), "--- a/x\n+++ b/x\n");
  fs.writeFileSync(path.join(outside, "build.log"), "Authorization: Bearer abc.def.ghi\n");
  fs.mkdirSync(path.join(tmp, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "secrets", "api-keys.json"), "{\"k\":\"v\"}");
});

beforeEach(() => {
  remoteRead.mockReset();
  employees.clear();
  employees.set("local-dev", { name: "local-dev" });
  employees.set("remote-dev", { name: "remote-dev", remoteHost: "build-box", remoteCwd: "/srv/work" });
});

function fakeRes() {
  const out: { status?: number; headers?: Record<string, unknown>; body?: Buffer | string } = {};
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) { out.status = status; out.headers = headers; return res; },
    end(body?: Buffer | string) { out.body = body; return res; },
  } as unknown as import("node:http").ServerResponse;
  return { res, out };
}

const context = { getConfig: () => ({}) } as unknown as import("../api.js").ApiContext;

async function call(
  sessionId: string,
  filePath: string | null,
  mode: "read" | "raw" = "read",
  caller: import("../session-comm-guards.js").CallerIdentity = { kind: "operator" },
) {
  const url = new URL(`http://gw/api/sessions/${sessionId}/files/${mode}`);
  if (filePath !== null) url.searchParams.set("path", filePath);
  const { res, out } = fakeRes();
  await handler.handleSessionFileRead(res, { sessionId, mode, url, caller }, context);
  const isJson = String(out.headers?.["Content-Type"] ?? "").startsWith("application/json");
  const json = isJson && out.body !== undefined ? JSON.parse(String(out.body)) : undefined;
  return { ...out, json };
}

describe("session file read — authority and shape", () => {
  it("refuses a capability-bound session caller", async () => {
    const r = await call("local-1", path.join(outside, "report.md"), "read", { kind: "session", callerId: "local-1" });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/operator-only/);
  });

  it("refuses an unauthenticated caller", async () => {
    const r = await call("local-1", path.join(outside, "report.md"), "read", { kind: "unauthenticated" });
    expect(r.status).toBe(403);
  });

  it("requires a path and an existing session", async () => {
    expect((await call("local-1", null)).status).toBe(400);
    expect((await call("local-1", "a\u0001b.txt")).status).toBe(400);
    expect((await call("nope", path.join(outside, "report.md"))).status).toBe(404);
  });
});

describe("session file read — local employee", () => {
  it("previews an absolute text file on the gateway", async () => {
    const r = await call("local-1", path.join(outside, "report.md"));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ content: "# Report\n", binary: false, tooLarge: false, mime: "text/markdown" });
    expect(r.json.host).toBeUndefined();
  });

  it("resolves a relative path against the session's working directory (JINN_HOME)", async () => {
    const r = await call("local-1", "notes.txt");
    expect(r.status).toBe(200);
    expect(r.json.resolvedPath).toBe(path.join(tmp, "notes.txt"));
  });

  it("applies the file-read policy", async () => {
    const r = await call("local-1", path.join(tmp, "secrets", "api-keys.json"));
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/secrets/i);
  });

  it("answers 404 for a missing file", async () => {
    expect((await call("local-1", path.join(outside, "missing.md"))).status).toBe(404);
  });

  it.each(["main.py", "run.sh", "fix.patch", "Dockerfile", "build.log"])("previews %s (no known MIME) as text, judged by its content", async (name) => {
    const r = await call("local-1", path.join(outside, name));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ binary: false, mime: "text/plain" });
    expect(typeof r.json.content).toBe("string");
  });

  it("redacts secrets in text it returns, like the managed readers", async () => {
    const sh = await call("local-1", path.join(outside, "run.sh"));
    expect(sh.json.content).toContain("API_TOKEN=[REDACTED]");
    expect(sh.json.content).not.toContain("abc123secret");
    const log = await call("local-1", path.join(outside, "build.log"));
    expect(log.json.content).not.toContain("abc.def.ghi");
  });

  it("redacts a remote file's text too", async () => {
    remoteRead.mockImplementation(async ({ op }: { op: string }) => op === "vet"
      ? { ok: true, realPath: "/srv/work/.env.example", size: 30 }
      : { ok: true, realPath: "/srv/work/.env.example", size: 30, buffer: Buffer.from("GITHUB_TOKEN=ghp_abcdefghijklmnop\n") });
    const r = await call("remote-1", ".env.example");
    expect(r.json.content).not.toContain("ghp_abcdefghijklmnop");
  });

  it("marks a NUL-bearing text file binary without returning its bytes", async () => {
    const r = await call("local-1", path.join(outside, "blob.txt"));
    expect(r.json).toMatchObject({ binary: true, previewable: false });
    expect(r.json.content).toBeUndefined();
  });

  it("describes an image as previewable without inlining it", async () => {
    const r = await call("local-1", path.join(outside, "shot.png"));
    expect(r.json).toMatchObject({ binary: true, previewable: true, mime: "image/png", size: PNG.length });
    expect(r.json.content).toBeUndefined();
  });

  it("serves image bytes raw with headers that stop them executing", async () => {
    const r = await call("local-1", path.join(outside, "shot.png"), "raw");
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body as Buffer, PNG)).toBe(0);
    expect(r.headers).toMatchObject({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });

  it("refuses a non-image raw request before reading its bytes", async () => {
    remoteRead.mockResolvedValue({ ok: true, realPath: "/srv/work/big.log", size: 15_000_000 });
    expect((await call("remote-1", "big.log", "raw")).status).toBe(415);
    expect(remoteRead).toHaveBeenCalledTimes(1);
    expect(remoteRead).toHaveBeenCalledWith(expect.objectContaining({ op: "vet" }));
  });

  it("refuses to serve SVG or text raw", async () => {
    expect((await call("local-1", path.join(outside, "diagram.svg"), "raw")).status).toBe(415);
    expect((await call("local-1", path.join(outside, "report.md"), "raw")).status).toBe(415);
    const svg = await call("local-1", path.join(outside, "diagram.svg"));
    expect(svg.json).toMatchObject({ binary: true, previewable: false });
  });
});

describe("session file read — remote employee", () => {
  it("reads on the build host, as the session's engine, and names the host", async () => {
    remoteRead.mockImplementation(async ({ op }: { op: string }) => op === "vet"
      ? { ok: true, realPath: "/srv/work/out/log.txt", size: 6 }
      : { ok: true, realPath: "/srv/work/out/log.txt", size: 6, buffer: Buffer.from("hello\n") });

    const r = await call("remote-1", "out/log.txt");

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ host: "build-box", content: "hello\n", resolvedPath: "/srv/work/out/log.txt" });
    expect(remoteRead).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ remoteHost: "build-box", remoteCwd: "/srv/work" }),
      sessionId: "remote-1",
      engine: "claude",
      requestedPath: "out/log.txt",
      op: "vet",
    }));
  });

  it("passes the host's refusal through", async () => {
    remoteRead.mockResolvedValue({ ok: false, status: 502, error: "could not reach build-box" });
    const r = await call("remote-1", "/srv/work/x.md");
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/build-box/);
  });

  it("never reads a remote employee's path on the gateway", async () => {
    remoteRead.mockResolvedValue({ ok: false, status: 404, error: "file not found" });
    const r = await call("remote-1", path.join(outside, "report.md"));
    expect(r.status).toBe(404);
    expect(remoteRead).toHaveBeenCalled();
  });
});

describe("handleSessionFileRoutes", () => {
  async function route(method: string, pathname: string) {
    const { res, out } = fakeRes();
    const url = new URL(`http://gw${pathname}`);
    const req = {} as import("node:http").IncomingMessage;
    const handled = await handler.handleSessionFileRoutes(req, res, { method, pathname: url.pathname, url }, () => ({ kind: "operator" }), context);
    return { handled, ...out };
  }

  it("leaves other session routes alone", async () => {
    expect((await route("GET", "/api/sessions/local-1/files/write")).handled).toBe(false);
    expect((await route("POST", "/api/sessions/local-1/files/read")).handled).toBe(false);
    expect((await route("GET", "/api/sessions/local-1")).handled).toBe(false);
  });

  it("answers 404 for an attachment to an unknown session", async () => {
    expect(await route("POST", "/api/sessions/nope/attachments")).toMatchObject({ handled: true, status: 404 });
  });

  it("dispatches a file read", async () => {
    const r = await route("GET", `/api/sessions/local-1/files/read?path=${encodeURIComponent(path.join(outside, "report.md"))}`);
    expect(r).toMatchObject({ handled: true, status: 200 });
  });
});
