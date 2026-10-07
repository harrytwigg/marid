import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The operator's chat file links for a department-scoped remote session resolve on the
 * host against the department's stage directory, the session's real cwd (FR-061);
 * an unscoped remote session's links resolve against its employee's remoteCwd as before.
 */

const hoisted = vi.hoisted(() => ({ session: undefined as undefined | Record<string, unknown> }));
const remoteRead = vi.fn();
vi.mock("../../engines/remote-file-read.js", () => ({ readRemoteSessionFile: (...args: unknown[]) => remoteRead(...args) }));
vi.mock("../../sessions/registry.js", () => ({ getSession: () => hoisted.session }));
vi.mock("../org-registry.js", () => ({
  orgRegistry: () => new Map([["remote-dev", { name: "remote-dev", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" }]]),
}));

import { handleSessionFileRead } from "../session-file-read.js";

const config = { remote: { root: "/srv/root", mount: "/mnt/jinn" } };

async function read(scopeDepartment: string | null) {
  hoisted.session = { id: "s1", engine: "claude", employee: "remote-dev", scopeDepartment };
  const url = new URL("http://gw/api/sessions/s1/files/read?path=notes.md");
  const res = { writeHead: () => res, end: () => res } as unknown as import("node:http").ServerResponse;
  await handleSessionFileRead(res, { sessionId: "s1", mode: "read", url, caller: { kind: "operator" } }, { getConfig: () => config } as unknown as import("../api.js").ApiContext);
  return remoteRead.mock.calls[0]![0];
}

beforeEach(() => {
  remoteRead.mockReset();
  remoteRead.mockResolvedValue({ ok: false, status: 404, error: "not found" });
});

describe("a chat file link in a remote session", () => {
  it("is read from the host with the department's stage directory as the target's remoteCwd when the session is scoped", async () => {
    const call = await read("side-project");
    expect(call.requestedPath).toBe("notes.md");
    expect(call.target).toMatchObject({
      remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/.jinn-departments/side-project",
      remoteDepartment: "side-project", remoteWorkArea: "/srv/root/work",
    });
  });

  it("is read against the employee's own remoteCwd when the session is not scoped", async () => {
    const call = await read(null);
    expect(call.target).toMatchObject({ remoteHost: "build-box", remoteCwd: "/srv/root/work" });
    expect(call.target.remoteDepartment).toBeUndefined();
  });
});
