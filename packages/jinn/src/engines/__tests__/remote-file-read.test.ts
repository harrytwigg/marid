import { describe, it, expect, beforeAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * The ssh hop is replaced by running the command locally under `sh -c`, with
 * the script on stdin exactly as ssh would deliver it, against a stand-in policy
 * module laid out where a remote install keeps it. That exercises the real
 * argument quoting, the script, and the answer parsing end to end.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-rfr-")));
const entryDir = path.join(root, "install", "dist", "src", "mcp");
const sshCalls: Array<{ destination: string; command: string }> = [];
let sshExit: number | null = 0;

vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    gatherFacts: async () => ({ home: path.join(root, "home"), stageDir: path.join(root, "home", ".jinn-remote-stage"), nodeBin: process.execPath, jinnVersion: "x", entryDir }),
    sshRun: async (destination: string, args: string[], opts: { stdin?: string }) => {
      sshCalls.push({ destination, command: args[0] });
      if (sshExit !== 0) return { code: sshExit, stdout: "", stderr: "ssh: connect to host build-box port 22: No route to host" };
      const run = spawnSync("sh", ["-c", args[0]], { input: opts.stdin, encoding: "utf8" });
      return { code: run.status, stdout: run.stdout, stderr: run.stderr };
    },
  };
});

let mod: typeof import("../remote-file-read.js");

beforeAll(async () => {
  const shared = path.join(entryDir, "..", "shared");
  fs.mkdirSync(shared, { recursive: true });
  // Stand-in for the install's file-read-policy.js: records what it was asked
  // and refuses anything under a `secrets` segment, as the real policy would.
  fs.writeFileSync(path.join(shared, "file-read-policy.js"), `
import fs from "node:fs";
export const expandPath = (p) => p.startsWith("~/") ? ${JSON.stringify(path.join(root, "home"))} + p.slice(1) : p;
const refuse = (p) => p.split("/").includes("secrets") ? { ok: false, status: 403, error: "Refusing to read Jinn secrets" } : null;
export function vetLocalFileForIngestion(p, max, opts) {
  const r = refuse(p); if (r) return r;
  if (!fs.existsSync(p)) return { ok: false, status: 404, error: "file not found: " + p };
  return { ok: true, realPath: p + "#home=" + opts.jinnHome, size: fs.statSync(p).size };
}
export function readLocalFileForIngestion(p, max, opts) {
  const r = refuse(p); if (r) return r;
  const buffer = fs.readFileSync(p);
  if (buffer.length > max) return { ok: false, status: 413, error: "too big" };
  return { ok: true, realPath: p, buffer };
}
`);
  fs.mkdirSync(path.join(root, "work", "out"), { recursive: true });
  fs.writeFileSync(path.join(root, "work", "out", "it's a log.txt"), "remote bytes\n");
  fs.mkdirSync(path.join(root, "home", "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "home", "notes", "plan.md"), "plan\n");
  mod = await import("../remote-file-read.js");
});

const target = { remoteHost: "build-box", remoteUser: "dev", remoteCwd: path.join(root, "work") };

function read(requestedPath: string, op: "vet" | "read" = "read", maxBytes = 1024) {
  return mod.readRemoteSessionFile({ target, sessionId: "s-1", engine: "claude", requestedPath, op, maxBytes });
}

describe("readRemoteSessionFile", () => {
  it("reads a cwd-relative path on the host and returns its bytes", async () => {
    const r = await read("out/it's a log.txt");
    expect(r).toMatchObject({ ok: true, realPath: path.join(root, "work", "out", "it's a log.txt"), size: 13 });
    expect(r.ok && r.buffer?.toString()).toBe("remote bytes\n");
    expect(sshCalls.at(-1)?.destination).toBe("dev@build-box");
  });

  it("expands ~ on the host and vets against the session's stage home", async () => {
    const r = await read("~/notes/plan.md", "vet");
    expect(r.ok).toBe(true);
    expect(r.ok && r.realPath).toBe(`${path.join(root, "home", "notes", "plan.md")}#home=${path.join(root, "home", ".jinn-remote-stage", "sessions", "s-1__claude")}`);
    expect(r.ok && r.buffer).toBeUndefined();
  });

  it("passes the host's policy refusal and size limit through", async () => {
    expect(await read("/x/secrets/api-keys.json")).toMatchObject({ ok: false, status: 403 });
    expect(await read("out/it's a log.txt", "read", 4)).toMatchObject({ ok: false, status: 413 });
    expect(await read("out/missing.txt", "vet")).toMatchObject({ ok: false, status: 404 });
  });

  it("reports an unreachable host as 502", async () => {
    sshExit = 255;
    try {
      expect(await read("out/it's a log.txt")).toMatchObject({ ok: false, status: 502, error: expect.stringMatching(/could not reach dev@build-box/) });
    } finally {
      sshExit = 0;
    }
  });
});

describe("parseRemoteFileAnswer", () => {
  it("rejects output that is not the script's JSON", () => {
    expect(mod.parseRemoteFileAnswer("motd banner\n", "h")).toMatchObject({ ok: false, status: 502 });
  });

  it("takes the last line, so a login banner cannot shadow the answer", () => {
    expect(mod.parseRemoteFileAnswer("welcome\n{\"ok\":true,\"realPath\":\"/a\",\"size\":1}\n", "h")).toEqual({ ok: true, realPath: "/a", size: 1 });
  });

  it("points at the policy module beside the install's MCP entrypoints", () => {
    expect(mod.remotePolicyModule({ entryDir: "/opt/jinn/dist/src/mcp" } as never)).toBe("/opt/jinn/dist/src/shared/file-read-policy.js");
  });
});
