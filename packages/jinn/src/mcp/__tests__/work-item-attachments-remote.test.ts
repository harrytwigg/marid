import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-remote-attachments-home-"));

let api: typeof import("../../gateway/api.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;

beforeAll(async () => {
  seedPlatformOrg(process.env.JINN_HOME!);
  ({ buildWorkItemTools } = await import("../work-item-tools.js"));
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
});

function tool(name: string): JinnMcpTool {
  const t = buildWorkItemTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function ctxFor(callerSessionId: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: inProcessGatewayFetch(api),
    callerSessionId,
    sessionCapability: ensureSessionCapability(callerSessionId),
  };
}

/**
 * sessions on a remote build host. The gateway cannot see the
 * session's disk, so a file that exists on the session's host must travel as
 * bytes; a path only the gateway can see must still use the JSON path mode; and
 * a listed attachment must be readable from the session's host.
 */
describe("work-item attachments from a session on another host", () => {
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

  /** Wrap the in-process gateway so a hook runs AFTER the MCP tool has decided
   *  what to send but BEFORE the gateway handles it — the seam that lets one
   *  process play two hosts. */
  function ctxWithGatewayHook(sessionId: string, beforeGateway: (init?: RequestInit) => void) {
    const ctx = ctxFor(sessionId);
    const inner = ctx.fetchFn!;
    const seen: Array<{ contentType?: string; multipart: boolean }> = [];
    ctx.fetchFn = (async (input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).includes("/attachments")) {
        const headers = (init.headers as Record<string, string>) ?? {};
        seen.push({ contentType: headers["content-type"], multipart: init.body instanceof FormData });
        beforeGateway(init);
      }
      return inner(input, init);
    }) as typeof fetch;
    return { ctx, seen };
  }

  it("uploads a session-host file as bytes the gateway never reads from disk (sha256 intact)", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-remote", title: "remote", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 remote upload", assignee: "platform-dev" });
    const buildHost = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-build-host-"));
    const source = path.join(buildHost, "evidence.bin");
    const sourceBytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256)); // > the 64 KiB JSON cap
    fs.writeFileSync(source, sourceBytes);
    // The build host's file is gone from the gateway's point of view: it is
    // deleted before the gateway handles the request, so a path-mode request
    // would 404. Only the bytes in the request can land it.
    const { ctx, seen } = ctxWithGatewayHook(dev.id, () => fs.rmSync(source, { force: true }));

    const attached = (await tool("attach_to_work_item").handler({ id: item.id, path: source, filename: "renamed.bin" }, ctx)) as {
      attachment: { id: string; filename: string; sha256: string; bytes: number; uploadedBy: string };
    };
    expect(seen).toEqual([{ contentType: undefined, multipart: true }]);
    expect(attached.attachment).toMatchObject({ filename: "renamed.bin", bytes: sourceBytes.length, sha256: sha(sourceBytes), uploadedBy: "platform-dev" });

    // Comment attachments ride the same bytes path.
    fs.writeFileSync(source, sourceBytes);
    const commented = (await tool("comment_work_item").handler({ id: item.id, body: "remote evidence", attachments: [source] }, ctx)) as {
      comment: { id: string };
      attachments: Array<{ commentId: string | null; sha256: string; filename: string }>;
    };
    expect(commented.attachments).toEqual([expect.objectContaining({ commentId: commented.comment.id, sha256: sha(sourceBytes), filename: "evidence.bin" })]);
    expect(seen.map((s) => s.multipart)).toEqual([true, true]);
  });

  it("never falls back to a gateway-side path and refuses relative paths outright (review B3, R3)", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-no-fallback", title: "no fallback", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 no fallback", assignee: "platform-dev" });
    const absent = path.join(process.env.JINN_HOME!, "tmp", `absent-here-${Date.now()}.txt`);
    // The gateway WOULD find a file there by the time it handled a path-mode
    // request — the stale same-named file B3 is about. The tool must not ask.
    const { ctx, seen } = ctxWithGatewayHook(dev.id, () => {
      fs.mkdirSync(path.dirname(absent), { recursive: true });
      fs.writeFileSync(absent, "stale gateway copy");
    });
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: absent }, ctx)).rejects.toThrow(/file not found/);

    // A relative name that also exists under the instance home (R3: a repo's
    // docs/x.md must never become Jinn's own copy) — refused, not resolved.
    fs.mkdirSync(path.join(process.env.JINN_HOME!, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(process.env.JINN_HOME!, "uploads", "gen140-relative.txt"), "the instance home's copy");
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: "uploads/gen140-relative.txt" }, ctx)).rejects.toThrow(
      /pass an absolute path/,
    );
    await expect(
      tool("comment_work_item").handler({ id: item.id, body: "x", attachments: ["uploads/gen140-relative.txt"] }, ctx),
    ).rejects.toThrow(/pass an absolute path/);
    expect(seen).toEqual([]);
  });

  it("tells the agent an unanswered upload may have landed, rather than to retry blindly (review S-a)", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-timeout", title: "timeout", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 timeout", assignee: "platform-dev" });
    const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen140-timeout-")), "slow.txt");
    fs.writeFileSync(source, "slow");
    const ctx: JinnMcpContext = { ...ctxFor(dev.id), timeoutMs: 20, fetchFn: (() => new Promise(() => {})) as unknown as typeof fetch };
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: source }, ctx)).rejects.toThrow(
      /got no answer from the gateway \(timed out after 20ms\); it may still have landed — check list_work_item_attachments/,
    );
    // fetch's own shape: "fetch failed", the socket's code on `cause`.
    const failing = (code: string): JinnMcpContext => ({
      ...ctxFor(dev.id),
      fetchFn: (() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }))) as unknown as typeof fetch,
    });
    // A connection that never opened did not land anything: its own message stands.
    const refused = String(await tool("attach_to_work_item").handler({ id: item.id, path: source }, failing("ECONNREFUSED")).catch((e: Error) => e));
    expect(refused).toMatch(/failed before a response: fetch failed \(ECONNREFUSED\)/);
    expect(refused).not.toMatch(/may still have landed/);
    // A socket dropped after the body went out may have been stored (review round 4, S2).
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET"]) {
      const dropped = String(await tool("attach_to_work_item").handler({ id: item.id, path: source }, failing(code)).catch((e: Error) => e));
      expect(dropped, code).toMatch(new RegExp(`got no answer from the gateway \\(fetch failed \\(${code}\\)\\); it may still have landed`));
      expect(dropped, code).not.toMatch(/retry;|then retry|Retry/); // only "before retrying", after the check
    }
  });

  it.skipIf(process.platform === "win32")("keeps quotes from the on-disk name itself (POSIX filenames allow them)", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-disk-quotes", title: "disk quotes", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 disk quotes", assignee: "platform-dev" });
    const quoted = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen140-disk-quotes-")), 'Q3 "final" résumé.pdf');
    fs.writeFileSync(quoted, "%PDF-");
    const attached = (await tool("attach_to_work_item").handler({ id: item.id, path: quoted }, ctxFor(dev.id))) as { attachment: { filename: string } };
    expect(attached.attachment.filename).toBe('Q3 "final" résumé.pdf');
  });

  it("keeps a filename with quotes intact and refuses an empty file with the store's own message (review N1, N2)", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-names", title: "names", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 names", assignee: "platform-dev" });
    const ctx = ctxFor(dev.id);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-names-"));
    // Quotes are legal in a POSIX filename but not a Windows one, so the name
    // rides the filename argument — the same multipart part header either way.
    const source = path.join(dir, "q3.pdf");
    fs.writeFileSync(source, "%PDF-");
    const attached = (await tool("attach_to_work_item").handler({ id: item.id, path: source, filename: 'Q3 "final" résumé.pdf' }, ctx)) as {
      attachment: { filename: string };
    };
    expect(attached.attachment.filename).toBe('Q3 "final" résumé.pdf');

    const empty = path.join(dir, "empty.txt");
    fs.writeFileSync(empty, "");
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: empty }, ctx)).rejects.toThrow(/attachment must not be empty/);
  });

  it("refuses a policy-blocked or oversized session-host file locally, sending nothing and never falling back to the gateway", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-policy", title: "policy", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 policy", assignee: "platform-dev" });
    const { ctx, seen } = ctxWithGatewayHook(dev.id, () => {});
    const buildHost = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-policy-"));

    const envFile = path.join(buildHost, ".env.production");
    fs.writeFileSync(envFile, "SECRET=1");
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: envFile }, ctx)).rejects.toThrow(/cannot attach .*: Refusing to read environment secret files/);

    const secret = path.join(process.env.JINN_HOME!, "secrets", "gen140.json");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "{}");
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: secret }, ctx)).rejects.toThrow(/Refusing to read Jinn secrets/);

    const big = path.join(buildHost, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 25 * 1024 * 1024 + 1);
    await expect(tool("attach_to_work_item").handler({ id: item.id, path: big }, ctx)).rejects.toThrow(/25 MB per-file limit \(attachment_too_large\)/);

    expect(seen).toEqual([]);
  });

  it("lists each attachment with this host's localPath (through a remote staging home) and a download URL", async () => {
    const dev = registry.createSession({ engine: "claude", source: "web", sourceRef: "gen140-list", title: "list", employee: "platform-dev" });
    const item = store.createWorkItem({ title: "gen140 list", assignee: "platform-dev" });
    const ctx = ctxFor(dev.id);
    const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen140-list-")), "notes.md");
    const bytes = Buffer.from("# read me back from the build host\n");
    fs.writeFileSync(source, bytes);
    const { attachment } = (await tool("attach_to_work_item").handler({ id: item.id, path: source }, ctx)) as { attachment: { id: string; storagePath: string } };

    type Listed = { attachments: Array<{ id: string; storagePath: string; localPath: string | null; downloadUrl: string | null }>; hint: string };
    // On the gateway host the mapped path IS the storage path.
    const local = (await tool("list_work_item_attachments").handler({ id: item.id }, ctx)) as Listed;
    expect(local.attachments[0].localPath).toBe(attachment.storagePath);
    expect(local.attachments[0].downloadUrl).toBe(`http://gateway.test/api/work-items/${item.id}/attachments/${attachment.id}?download=1`);
    expect(local.hint).toMatch(/JINN_GATEWAY_TOKEN/);

    // A remote host: the session's JINN_HOME is a staging dir whose
    // `attachments` links into the (mounted) gateway store. The gateway half of
    // this process keeps ITS home for the length of each request.
    const gatewayHome = process.env.JINN_HOME!;
    const inner = ctx.fetchFn!;
    ctx.fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const sessionHome = process.env.JINN_HOME;
      process.env.JINN_HOME = gatewayHome;
      try {
        return await inner(input, init);
      } finally {
        process.env.JINN_HOME = sessionHome;
      }
    }) as typeof fetch;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-stage-home-"));
    fs.symlinkSync(path.join(gatewayHome, "attachments"), path.join(stage, "attachments"));
    const unmounted = fs.mkdtempSync(path.join(os.tmpdir(), "gen140-unmounted-home-"));
    try {
      process.env.JINN_HOME = stage;
      const remote = (await tool("list_work_item_attachments").handler({ id: item.id }, ctx)) as Listed;
      const row = remote.attachments[0];
      expect(row.storagePath).toBe(attachment.storagePath); // the gateway's path, untouched
      expect(row.localPath!.startsWith(stage)).toBe(true);
      expect(sha(fs.readFileSync(row.localPath!))).toBe(sha(bytes));

      // No mount: no local path, but the URL still names the bytes.
      process.env.JINN_HOME = unmounted;
      const bare = (await tool("list_work_item_attachments").handler({ id: item.id }, ctx)) as Listed;
      expect(bare.attachments[0].localPath).toBeNull();
      expect(bare.attachments[0].downloadUrl).toContain(`/attachments/${attachment.id}?download=1`);
    } finally {
      process.env.JINN_HOME = gatewayHome;
    }
  });
});
