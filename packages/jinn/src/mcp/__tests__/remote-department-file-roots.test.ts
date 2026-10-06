import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSessionCapability } from "../identity.js";
import { remapMcpConfigForRemote, type RemoteMcpRemapOpts } from "../remote-config.js";
import { remoteDepartmentFileRoots } from "../../engines/remote-department-stage.js";
import { departmentPathRefusal } from "../../shared/department-file-roots.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import type { ResolvedMcpConfig, SessionRemoteTarget } from "../../shared/types.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-remote-roots-"));

/**
 * FR-065: on the remote host, a scoped session's jinn MCP server learns its file roots from
 * its staged config. The remap writes them (and only into a server that already carries the
 * variable); the two tools that read a path themselves then hold to them. Temporary
 * directories stand in for the host's work area and stage directory.
 */

const ROOTS_ENV = "JINN_DEPARTMENT_FILE_ROOTS";
const OPTS: RemoteMcpRemapOpts = { remoteNode: "/usr/bin/node", remoteEntryDir: "/srv/e", remoteHome: "/srv/h", gatewayUrl: "http://127.0.0.1:45123" };

describe("remapMcpConfigForRemote — the department file roots", () => {
  const config = (env: Record<string, string> | undefined): ResolvedMcpConfig => ({
    mcpServers: { jinn: { command: "node", args: ["x.js"], ...(env ? { env } : {}) } },
  } as ResolvedMcpConfig);
  const envOf = (resolved: ResolvedMcpConfig) => (resolved.mcpServers.jinn as { env?: Record<string, string> }).env;

  it("replaces the gateway's roots with the host's, as JSON", () => {
    const roots = ["/srv/root/work", "/srv/root/.jinn-departments/side-project"];
    expect(envOf(remapMcpConfigForRemote(config({ [ROOTS_ENV]: '["/gateway/work"]' }), { ...OPTS, departmentFileRoots: roots }))?.[ROOTS_ENV]).toBe(JSON.stringify(roots));
  });

  it("writes an empty list, which admits nothing, when none are given", () => {
    expect(envOf(remapMcpConfigForRemote(config({ [ROOTS_ENV]: '["/gateway/work"]' }), OPTS))?.[ROOTS_ENV]).toBe("[]");
  });

  it("never adds the variable to a server that did not have it", () => {
    expect(envOf(remapMcpConfigForRemote(config({ OTHER: "1" }), { ...OPTS, departmentFileRoots: ["/srv/root/work"] }))).toEqual({ OTHER: "1" });
    expect(envOf(remapMcpConfigForRemote(config(undefined), { ...OPTS, departmentFileRoots: ["/srv/root/work"] }))).toBeUndefined();
  });
});

describe("the attachment tools on the host", () => {
  let api: typeof import("../../gateway/api.js");
  let registry: typeof import("../../sessions/registry.js");
  let store: typeof import("../../work-items/store.js");
  let fileTools: typeof import("../file-tools.js");
  let workItemTools: typeof import("../work-item-tools.js");
  let session: import("../../shared/types.js").Session;
  let workArea: string;
  let stageDir: string;
  let outsideDir: string;
  let roots: string[];

  beforeAll(async () => {
    seedPlatformOrg(process.env.JINN_HOME!);
    api = await import("../../gateway/api.js");
    registry = await import("../../sessions/registry.js");
    store = await import("../../work-items/store.js");
    fileTools = await import("../file-tools.js");
    workItemTools = await import("../work-item-tools.js");
    (await import("../../shared/db.js")).initDb();
    session = registry.createSession({ engine: "claude", source: "web", sourceRef: "remote-roots", title: "tools", employee: "platform-dev" });
    const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
    [workArea, stageDir, outsideDir] = [tmp("host-work-"), tmp("host-stage-"), tmp("host-outside-")];
    fs.writeFileSync(path.join(workArea, "report.txt"), "work area\n");
    fs.writeFileSync(path.join(stageDir, "CLAUDE.md"), "stage\n");
    fs.writeFileSync(path.join(outsideDir, "elsewhere.txt"), "outside\n");
    fs.symlinkSync(path.join(outsideDir, "elsewhere.txt"), path.join(workArea, "escape.txt"));
    // The roots the staging code would hand a scoped session's server for these two directories.
    const target: SessionRemoteTarget = { remoteHost: "build-box", remoteCwd: stageDir, remoteDepartment: "side-project", remoteWorkArea: workArea };
    roots = remoteDepartmentFileRoots(target);
    vi.stubEnv(ROOTS_ENV, JSON.stringify(roots));
  });
  afterEach(() => vi.stubEnv(ROOTS_ENV, JSON.stringify(roots)));

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
    const item = store.createWorkItem({ title: "remote scoped attach", assignee: "platform-dev" });
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: inProcessGatewayFetch(api), callerSessionId: session.id, sessionCapability: ensureSessionCapability(session.id) };
    return { posted: [] as string[], run: () => pick(workItemTools.buildWorkItemTools(), "attach_to_work_item").handler({ id: item.id, path: file }, ctx) };
  }

  describe.each([["publish_attachment", publish], ["attach_to_work_item (path)", attach]] as const)("%s", (_name, start) => {
    it("takes a file inside the work area, and one inside the stage directory", async () => {
      await expect(start(path.join(workArea, "report.txt")).run()).resolves.toBeTruthy();
      await expect(start(path.join(stageDir, "CLAUDE.md")).run()).resolves.toBeTruthy();
    });

    it("refuses a file outside both, with the department's refusal text, before anything is sent", async () => {
      const file = path.join(outsideDir, "elsewhere.txt");
      const started = start(file);
      await expect(started.run()).rejects.toThrow(departmentPathRefusal(file, roots));
      expect(started.posted).toEqual([]);
    });

    it("refuses a symlink inside a root that points outside it", async () => {
      const file = path.join(workArea, "escape.txt");
      await expect(start(file).run()).rejects.toThrow(departmentPathRefusal(file, roots));
    });
  });
});
