import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host-readiness gate asks `ensureRemoteReady` about the target `employeeRemoteTarget`
 * builds (FR-061): for a scoped employee that carries the department's stage directory.
 */

const hoisted = vi.hoisted(() => ({ targets: [] as any[] }));

vi.mock("../../../engines/remote-stage.js", () => ({
  ensureRemoteReady: vi.fn(async (target: any) => {
    hoisted.targets.push(target);
    return { ready: true };
  }),
}));
vi.mock("../../registry.js", () => ({ getSession: vi.fn(() => ({ status: "running" })), updateSessionForAttempt: vi.fn() }));
vi.mock("../../callbacks.js", () => ({ notifyOperatorChannel: vi.fn() }));

import { ensureRemoteHostReady } from "../remote-ready.js";

const EMPLOYEE = { name: "side-dev", displayName: "Side Dev", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" } as any;

function input(scopeDepartment: string | null) {
  return {
    session: { id: "sess-1", employee: "side-dev", scopeDepartment },
    attemptToken: "tok-1",
    employee: EMPLOYEE,
    config: { remote: { root: "/srv/root", mount: "/mnt/jinn" } },
  } as any;
}

beforeEach(() => { hoisted.targets.length = 0; });

describe("ensureRemoteHostReady for a remote employee", () => {
  it("checks the host with the department's stage directory as the target's remoteCwd when the session is scoped", async () => {
    expect(await ensureRemoteHostReady(input("side-project"), "claude")).toEqual({ ok: true });
    expect(hoisted.targets).toHaveLength(1);
    expect(hoisted.targets[0]).toMatchObject({
      remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/.jinn-departments/side-project",
      remoteDepartment: "side-project", remoteWorkArea: "/srv/root/work",
    });
  });

  it("checks the host with the employee's own remoteCwd when the session is not scoped", async () => {
    await ensureRemoteHostReady(input(null), "claude");
    expect(hoisted.targets[0]).toMatchObject({ remoteHost: "build-box", remoteCwd: "/srv/root/work" });
    expect(hoisted.targets[0].remoteDepartment).toBeUndefined();
  });
});
