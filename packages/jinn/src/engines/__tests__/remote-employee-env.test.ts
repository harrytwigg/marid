import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * A remote session's `session-env.sh`, staged for real, exports `JINN_EMPLOYEE` for a session that
 * has an employee, on every engine that runs remotely, and leaves it out for one that has none.
 * `ssh` is replaced by a local `sh` (as in remote-department-staging.test.ts), so
 * `prepareRemoteSession` writes the file into a temporary directory standing in for the host.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      return actual.spawn("sh", ["-c", args.slice(args.indexOf("--") + 2).join(" ")], options);
    }) as typeof actual.spawn,
  };
});
vi.mock("../../gateway/gateway-info.js", () => ({
  readGatewayInfo: () => ({ port: 40123, secret: "hook-secret", token: "bearer-token" }),
}));

const { prepareRemoteSession, clearRemoteStagingCache } = await import("../remote-stage.js");
const { createSession, deleteSession } = await import("../../sessions/registry.js");

let tmp: string;
let remote: RemoteExecutionConfig;
let facts: import("../remote-stage.js").RemoteFacts;
const sessionIds: string[] = [];

function session(engine: string, employee?: string): string {
  const created = createSession({ engine, source: "web", sourceRef: `web:${employee ?? "none"}`, ...(employee ? { employee } : {}) });
  sessionIds.push(created.id);
  return created.id;
}

async function envFileOf(engine: "claude" | "pi" | "opencode", jinnSessionId: string): Promise<string> {
  const staging = await prepareRemoteSession({
    target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") }, remote, facts, engine, jinnSessionId, gatewayPort: 40123,
  } as never);
  return fs.readFileSync(staging.envFilePath, "utf-8");
}

beforeEach(() => {
  clearRemoteStagingCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-employee-env-")));
  const mount = path.join(tmp, "mount");
  fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mount, "CLAUDE.md"), "company rules\n");
  fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "host", "profile"), { recursive: true });
  remote = { root: path.join(tmp, "root"), mount, claudeConfigDir: path.join(tmp, "host", "profile") } as RemoteExecutionConfig;
  facts = {
    home: path.join(tmp, "host"), stageDir: path.join(tmp, "host", ".jinn-remote-stage"), nodeBin: process.execPath,
    claudeBin: "/bin/true", jinnVersion: "0.0.0", entryDir: path.join(tmp, "host", "entry"),
  };
});

afterEach(() => {
  for (const id of sessionIds.splice(0)) deleteSession(id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("a remote session's session-env.sh", { timeout: 60_000 }, () => {
  for (const engine of ["claude", "pi", "opencode"] as const) {
    it(`exports JINN_EMPLOYEE for a ${engine} session with an employee, and not for one without`, async () => {
      const withEmployee = await envFileOf(engine, session(engine, "build-dev"));
      expect(withEmployee).toContain("export JINN_EMPLOYEE='build-dev'\n");
      expect(withEmployee).toContain("export JINN_GATEWAY_TOKEN='bearer-token'");

      const without = await envFileOf(engine, session(engine));
      expect(without).not.toContain("JINN_EMPLOYEE");
    });
  }
});
