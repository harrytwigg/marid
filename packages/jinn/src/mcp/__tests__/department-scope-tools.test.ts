import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-department-scope-"));

/**
 * FR-018 in the two MCP tools that read a path themselves, and FR-019's tool profile.
 * A scoped session's MCP server is started with `JINN_DEPARTMENT_FILE_ROOTS`; without
 * it the tools behave as they always did.
 */

const ROOTS_ENV = "JINN_DEPARTMENT_FILE_ROOTS";
const OUTSIDE = /is outside this department's working directories and stage directory/;

let api: typeof import("../../gateway/api.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let fileTools: typeof import("../file-tools.js");
let workItemTools: typeof import("../work-item-tools.js");
let session: import("../../shared/types.js").Session;
let workdir: string;
let outsideDir: string;
const inside = () => path.join(workdir, "report.txt");
const outside = () => path.join(outsideDir, "elsewhere.txt");

beforeAll(async () => {
  seedPlatformOrg(process.env.JINN_HOME!);
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  fileTools = await import("../file-tools.js");
  workItemTools = await import("../work-item-tools.js");
  (await import("../../shared/db.js")).initDb();
  session = registry.createSession({ engine: "claude", source: "web", sourceRef: "dept-tools", title: "tools", employee: "platform-dev" });
  workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dept-workdir-")));
  outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dept-outside-")));
  fs.writeFileSync(inside(), "inside the department\n");
  fs.writeFileSync(outside(), "outside the department\n");
  fs.symlinkSync(outside(), path.join(workdir, "escape.txt"));
});

afterEach(() => vi.unstubAllEnvs());

const roots = (...dirs: string[]) => vi.stubEnv(ROOTS_ENV, JSON.stringify(dirs));
const pick = (tools: JinnMcpTool[], name: string) => tools.find((tool) => tool.name === name)!;

function publish(file: string) {
  const posted: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    posted.push(new URL(String(input)).pathname);
    return { status: 201, text: async () => JSON.stringify({ id: "f1", media: { type: "file", url: "/api/files/f1", name: path.basename(file) } }) } as Response;
  }) as typeof fetch;
  const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", token: "tok", callerSessionId: session.id, sessionCapability: ensureSessionCapability(session.id), fetchFn };
  return { posted, run: () => pick(fileTools.buildFileTools(), "publish_attachment").handler({ path: file }, ctx) };
}

function attach(file: string) {
  const item = store.createWorkItem({ title: "scoped attach", assignee: "platform-dev" });
  const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: inProcessGatewayFetch(api), callerSessionId: session.id, sessionCapability: ensureSessionCapability(session.id) };
  return { posted: [] as string[], run: () => pick(workItemTools.buildWorkItemTools(), "attach_to_work_item").handler({ id: item.id, path: file }, ctx) };
}

describe.each([["publish_attachment", publish], ["attach_to_work_item (path)", attach]] as const)("%s", (_name, start) => {
  const go = (file: string) => start(file).run();

  it("takes a file inside the department's roots", async () => {
    roots(workdir);
    await expect(go(inside())).resolves.toBeTruthy();
  });

  it("refuses a file outside them, naming the roots, before anything is sent", async () => {
    roots(workdir);
    const started = start(outside());
    await expect(started.run()).rejects.toThrow(OUTSIDE);
    expect(started.posted).toEqual([]);
  });

  it("refuses a symlink inside a root that points outside it", async () => {
    roots(workdir);
    await expect(go(path.join(workdir, "escape.txt"))).rejects.toThrow(OUTSIDE);
  });

  it("refuses everything when its roots are unreadable or empty, so a scoped server fails closed", async () => {
    vi.stubEnv(ROOTS_ENV, "not json");
    await expect(go(inside())).rejects.toThrow(OUTSIDE);
    roots();
    await expect(go(inside())).rejects.toThrow(/none are configured/);
  });

  it("behaves as before when the roots are not set", async () => {
    expect(process.env[ROOTS_ENV]).toBeUndefined();
    await expect(go(outside())).resolves.toBeTruthy();
    await expect(go(inside())).resolves.toBeTruthy();
  });
});
