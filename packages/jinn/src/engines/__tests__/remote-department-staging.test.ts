import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * A department-scoped employee on a remote host, staged for real (FR-060 to FR-064).
 *
 * `ssh` is replaced by a local `sh` that runs the remote command exactly as the remote
 * shell would (ssh joins its arguments with spaces), so `prepareRemoteSession` runs its
 * real farm, asset, sync and trust-seed scripts against temporary directories standing in
 * for the host's home, the mounted gateway home and `remote.root`.
 *
 * The first test is the phase's opening red test: before scoped staging existed, this
 * employee's session home linked the company home and the company CLAUDE.md was linked
 * into its remoteCwd.
 */

const hoisted = vi.hoisted(() => ({ ssh: [] as string[], rewrite: undefined as ((command: string) => string) | undefined, mcp: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      const remote = args.slice(args.indexOf("--") + 2).join(" ");
      hoisted.ssh.push(remote);
      return actual.spawn("sh", ["-c", hoisted.rewrite?.(remote) ?? remote], options);
    }) as typeof actual.spawn,
  };
});

vi.mock("../../gateway/gateway-info.js", () => ({
  readGatewayInfo: () => ({ port: 40123, secret: "hook-secret", token: "bearer-token" }),
}));

vi.mock("../../gateway/department-registry.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  departmentRecord: (slug: string) => ({ slug, scope: "scoped", definition: { skills: ["helper"], mcp: hoisted.mcp, instructions: "department" }, definitionError: null, definitionFile: null, warnings: [] }),
}));

const { prepareRemoteSession, clearRemoteStagingCache } = await import("../remote-stage.js");
const { employeeRemoteTarget } = await import("../../shared/remote-target.js");
const { resolveJinnHome } = await import("../../shared/paths.js");

let tmp: string;
let remote: RemoteExecutionConfig;
let facts: import("../remote-stage.js").RemoteFacts;

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "side-dev", displayName: "Side Dev", department: "side-project", rank: "employee", engine: "claude",
    model: "opus", persona: "p", remoteHost: "box", remoteCwd: path.join(tmp, "root", "work"), ...overrides,
  } as Employee;
}

const scoped = () => ({ remoteRoot: remote.root, departmentOf: (e: Employee) => (e.department === "side-project" ? "side-project" : null) });

async function stage(target: ReturnType<typeof employeeRemoteTarget>, jinnSessionId = "s1") {
  return prepareRemoteSession({ target: target!, remote, facts, engine: "claude", jinnSessionId, gatewayPort: 40123 });
}

beforeEach(() => {
  hoisted.ssh.length = 0;
  hoisted.mcp = [];
  hoisted.rewrite = undefined;
  clearRemoteStagingCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-dept-")));
  const mount = path.join(tmp, "mount");
  fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mount, "CLAUDE.md"), "company rules\n");
  fs.writeFileSync(path.join(mount, "knowledge", "state.md"), "company state\n");
  fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "host", "profile"), { recursive: true });
  remote = { root: path.join(tmp, "root"), mount, claudeConfigDir: path.join(tmp, "host", "profile") } as RemoteExecutionConfig;
  facts = {
    home: path.join(tmp, "host"), stageDir: path.join(tmp, "host", ".jinn-remote-stage"), nodeBin: process.execPath,
    claudeBin: path.join(tmp, "host", "claude"), jinnVersion: "0.0.0", entryDir: path.join(tmp, "host", "entry"),
  };
  // Stands in for a Claude Code recent enough to know the setting the scoped settings rely on.
  fs.writeFileSync(facts.claudeBin!, '#!/bin/sh\n[ "$1" = --version ] && echo "2.1.291 (Claude Code)"\n', { mode: 0o755 });
  const home = resolveJinnHome();
  fs.mkdirSync(path.join(home, "knowledge", "departments", "side-project"), { recursive: true });
  fs.writeFileSync(path.join(home, "knowledge", "departments", "side-project", "INSTRUCTIONS.md"), "Side project rules.\n");
  fs.mkdirSync(path.join(home, "skills", "helper"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "helper", "SKILL.md"), "---\nname: helper\n---\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function links(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => fs.lstatSync(path.join(dir, name)).isSymbolicLink());
}

describe("a department-scoped employee on a remote host", { timeout: 60_000 }, () => {
  it("gets a home with no link into the mounted company home, and no CLAUDE.md in its work area", async () => {
    const staging = await stage(employeeRemoteTarget(employee(), scoped()));
    expect(links(staging.sessionHome)).toEqual([]);
    expect(fs.readdirSync(staging.sessionHome).sort()).toEqual([".jinn-remote-stage", "gateway.json", "tmp"]);
    expect(fs.existsSync(path.join(tmp, "root", "work", "CLAUDE.md"))).toBe(false);
  });

  it("runs in the department's stage directory, synced before the trust seed, with JINN_DEPARTMENT in its environment file", async () => {
    const target = employeeRemoteTarget(employee(), scoped())!;
    const stageDir = path.join(tmp, "root", ".jinn-departments", "side-project");
    expect(target).toMatchObject({ remoteCwd: stageDir, remoteDepartment: "side-project", remoteWorkArea: path.join(tmp, "root", "work") });
    const staging = await stage(target);
    expect(fs.readFileSync(path.join(stageDir, "CLAUDE.md"), "utf-8")).toContain("Side project rules.");
    expect(fs.existsSync(path.join(stageDir, ".claude", "skills", "helper", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(staging.envFilePath, "utf-8")).toContain("export JINN_DEPARTMENT='side-project'");
    const order = [
      (command: string) => command.includes("department-scoped, nothing here leads"),
      (command: string) => command.includes("remote department stage"),
      (command: string) => command.includes("remote-trust-seed.mjs' '"), // the seed run, not the asset's staging
    ].map((isStep) => hoisted.ssh.findIndex(isStep));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const trust = JSON.parse(fs.readFileSync(path.join(tmp, "host", "profile", ".claude.json"), "utf-8"));
    expect(Object.keys(trust.projects ?? {})).toContain(stageDir);
  });

  it("keeps the stage directory's inode across a second spawn and restores what a session edited", async () => {
    const target = employeeRemoteTarget(employee(), scoped())!;
    await stage(target, "s1");
    const stageDir = target.remoteCwd!;
    const inode = fs.statSync(stageDir).ino;
    fs.writeFileSync(path.join(stageDir, "CLAUDE.md"), "edited by a session\n");
    fs.writeFileSync(path.join(stageDir, "stray.txt"), "x");
    await stage(target, "s2");
    expect(fs.statSync(stageDir).ino).toBe(inode);
    expect(fs.readFileSync(path.join(stageDir, "CLAUDE.md"), "utf-8")).toContain("Side project rules.");
    expect(fs.existsSync(path.join(stageDir, "stray.txt"))).toBe(false);
  });

  it("leaves an unscoped remote employee's staging as it was: the farm, and the company CLAUDE.md in its cwd", async () => {
    const staging = await stage(employeeRemoteTarget(employee({ department: "engineering" }), scoped()));
    expect(links(staging.sessionHome)).toContain("CLAUDE.md");
    expect(fs.lstatSync(path.join(tmp, "root", "work", "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(tmp, "root", ".jinn-departments"))).toBe(false);
    expect(hoisted.ssh.some((command) => command.includes("remote department stage"))).toBe(false);
  });

  it("makes the work area, which the prompt sends the session to and the file tools hold paths to", async () => {
    fs.rmSync(path.join(tmp, "root", "work"), { recursive: true });
    await stage(employeeRemoteTarget(employee(), scoped()));
    expect(fs.statSync(path.join(tmp, "root", "work")).isDirectory()).toBe(true);
  });

  it("does not load the company CLAUDE.md an unscoped colleague's farm links into remote.root above it", async () => {
    // A colleague whose cwd is remote.root itself: valid, common, and its farm links the company rules there.
    await stage(employeeRemoteTarget(employee({ name: "eng-dev", department: "engineering", remoteCwd: remote.root }), scoped()), "colleague");
    expect(fs.readlinkSync(path.join(remote.root, "CLAUDE.md"))).toBe(path.join(remote.mount, "CLAUDE.md"));
    const staging = await stage(employeeRemoteTarget(employee(), scoped()), "scoped");
    const settings = JSON.parse(fs.readFileSync(staging.settingsPath, "utf-8"));
    expect(settings.claudeMdExcludes).toEqual(expect.arrayContaining([
      path.join(remote.root, "CLAUDE.md"),
      path.join(remote.root, "CLAUDE.local.md"),
      path.join(remote.root, ".jinn-departments", "CLAUDE.md"),
      "/CLAUDE.md",
    ]));
    const stageDir = path.join(remote.root, ".jinn-departments", "side-project");
    expect(settings.claudeMdExcludes.some((pattern: string) => pattern.startsWith(`${stageDir}/`))).toBe(false);
  });

  it("leaves an unscoped session's settings without exclusions", async () => {
    const staging = await stage(employeeRemoteTarget(employee({ department: "engineering" }), scoped()));
    expect(JSON.parse(fs.readFileSync(staging.settingsPath, "utf-8")).claudeMdExcludes).toBeUndefined();
  });

  it("is refused, before anything is staged, on a host whose Claude Code is too old to skip the CLAUDE.md files above it", async () => {
    fs.writeFileSync(facts.claudeBin!, '#!/bin/sh\necho "2.0.14 (Claude Code)"\n');
    await expect(stage(employeeRemoteTarget(employee(), scoped()))).rejects.toThrow(/reports 2\.0\.14; a department-scoped session needs 2\.1\.288 or later/);
    expect(hoisted.ssh).toHaveLength(1);
  });

  it("asks the host's Claude Code once, not on every spawn", async () => {
    const target = employeeRemoteTarget(employee(), scoped());
    await stage(target, "s1");
    await stage(target, "s2");
    expect(hoisted.ssh.filter((command) => command.endsWith("--version"))).toHaveLength(1);
  });

  it("is refused when the sync does not say where the stage directory resolves, rather than exclude one spelling only", async () => {
    hoisted.rewrite = (command) => (command.includes("remote department stage") ? `{ ${command}; } | grep -v '^real_stage='` : command);
    await expect(stage(employeeRemoteTarget(employee(), scoped()))).rejects.toThrow(/the sync did not report where it is/);
    expect(hoisted.ssh.some((command) => command.includes("remote-trust-seed.mjs' '"))).toBe(false);
  });

  it("is refused before anything is written when its work area overlaps the host's stage root", async () => {
    remote = { ...remote, root: tmp };
    const target = employeeRemoteTarget(employee({ remoteCwd: facts.home }), scoped())!;
    await expect(stage(target)).rejects.toThrow(/overlaps the host's stage root/);
    expect(hoisted.ssh).toEqual([]);
  });

  it("is refused when the host's stage root is not known", async () => {
    facts = { ...facts, stageDir: "" };
    await expect(stage(employeeRemoteTarget(employee(), scoped()))).rejects.toThrow(/stage root is not known/);
    expect(hoisted.ssh).toEqual([]);
  });

  it("is refused without remote.root rather than run in its work area", async () => {
    const target = employeeRemoteTarget(employee(), { ...scoped(), remoteRoot: undefined })!;
    expect(target.remoteCwd).toBeUndefined();
    await expect(stage(target)).rejects.toThrow(/Refusing to spawn a remote session/);
    expect(hoisted.ssh).toEqual([]);
  });
});

describe("a department-scoped remote session's MCP servers", { timeout: 60_000 }, () => {
  const SECRET = "instance-server-secret-value";
  // What the resolver hands over for an instance with extra servers: the belt, a browser,
  // a stdio server keyed in its env and a URL server keyed in its headers.
  const instanceMcp = () => ({
    mcpServers: {
      browser: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      jinn: { command: process.execPath, args: [path.join(facts.entryDir!, "server-entry.js")], env: { JINN_HOME: "/home" } },
      alpha: { command: "npx", args: ["alpha-mcp"], env: { ALPHA_API_KEY: SECRET } },
      beta: { type: "sse", url: "https://beta.invalid/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
    },
  }) as unknown as import("../../shared/types.js").ResolvedMcpConfig;

  async function stageMcp(target: ReturnType<typeof employeeRemoteTarget>) {
    const staging = await prepareRemoteSession({ target: target!, remote, facts, engine: "claude", jinnSessionId: "s1", gatewayPort: 40123, resolvedMcp: instanceMcp() });
    return { staging, text: fs.readFileSync(staging.mcpConfigPath!, "utf-8") };
  }

  function stagedText(dir: string): string {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf-8"))
      .join("\n");
  }

  it("stages the jinn server alone, and no other server's credentials anywhere in the stage", async () => {
    const { staging, text } = await stageMcp(employeeRemoteTarget(employee(), scoped()));
    expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(["jinn"]);
    expect(stagedText(staging.sessionHome)).not.toContain(SECRET);
  });

  it("stages the servers its department allow-lists beside jinn, and only those", async () => {
    hoisted.mcp = ["alpha", "not-configured"];
    const { text } = await stageMcp(employeeRemoteTarget(employee(), scoped()));
    expect(Object.keys(JSON.parse(text).mcpServers).sort()).toEqual(["alpha", "jinn"]);
    expect(text).not.toContain("beta.invalid");
  });

  it("leaves an unscoped remote session's servers as resolved", async () => {
    const { text } = await stageMcp(employeeRemoteTarget(employee({ department: "engineering" }), scoped()));
    expect(Object.keys(JSON.parse(text).mcpServers).sort()).toEqual(["alpha", "beta", "browser", "jinn"]);
  });
});
