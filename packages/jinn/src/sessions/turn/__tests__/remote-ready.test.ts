import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The remote-host gate, and the two ways it used to lose a turn.
 *
 * Both failures share one shape and it is the worst one this feature has: the
 * gateway believes a session is progressing when nothing is going to happen.
 * A walk-away employee has nobody watching the UI, so a turn that neither
 * completes nor reports is indistinguishable from one still working.
 */

const hoisted = vi.hoisted(() => ({
  readiness: { ready: true } as any,
  waitStart: undefined as undefined | ((info: { destination: string; waking: boolean; waitingFor?: "host" | "mount" }) => void),
  notifications: [] as string[],
  updates: [] as { fields: any; expected?: readonly string[] }[],
  /** Statuses `updateSessionForAttempt` will accept, i.e. the DB's fence. */
  status: "running" as string,
}));

vi.mock("../../../engines/remote-stage.js", () => ({
  ensureRemoteReady: vi.fn(async (_t: any, _r: any, opts: any) => {
    hoisted.waitStart = opts.onWaitStart;
    return hoisted.readiness;
  }),
}));

vi.mock("../../registry.js", () => ({
  getSession: vi.fn(() => ({ status: hoisted.status })),
  updateSessionForAttempt: vi.fn((_id: string, _tok: string, fields: any, expected?: readonly string[]) => {
    hoisted.updates.push({ fields, expected });
    // Model the real fence: the write only lands from an expected status.
    if (expected && !expected.includes(hoisted.status)) return undefined;
    if (fields.status) hoisted.status = fields.status;
    return { status: hoisted.status };
  }),
}));

vi.mock("../../callbacks.js", () => ({
  notifyOperatorChannel: vi.fn((m: string) => { hoisted.notifications.push(m); }),
}));

import { ensureRemoteHostReady, shouldNotifyWake } from "../remote-ready.js";

const EMPLOYEE = {
  name: "builder",
  displayName: "Builder",
  remoteHost: "build-box",
  remoteUser: "builder",
  remoteCwd: "/srv/agents/proj",
} as any;

function input(employee: any = EMPLOYEE, remote: Record<string, unknown> = {}) {
  return {
    session: { id: "sess-1" },
    attemptToken: "tok-1",
    employee,
    config: { remote: { root: "/srv/agents", mount: "/mnt/jinn-home", ...remote } },
  } as any;
}

beforeEach(() => {
  hoisted.readiness = { ready: true };
  hoisted.waitStart = undefined;
  hoisted.notifications = [];
  hoisted.updates = [];
  hoisted.status = "running";
});

describe("ensureRemoteHostReady", () => {
  it("is a no-op for a local employee", async () => {
    expect(await ensureRemoteHostReady(input(undefined), "claude")).toEqual({ ok: true });
    expect(hoisted.updates).toHaveLength(0);
  });

  it("refuses a remote employee on an engine that cannot go remote", async () => {
    // codex/grok simply ignore `remoteHost`. Without this the turn runs on the
    // GATEWAY with --dangerously-skip-permissions, against a checkout that is
    // not there, while the UI shows a remote employee working normally.
    const res = await ensureRemoteHostReady(input(), "codex") as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("codex");
    expect(res.error).toContain("no remote support");
  });

  it("lets a remote-capable engine through, and asks the host about that engine's own CLI", async () => {
    // Pi is the second engine that can relocate a turn. Refusing it here would
    // have made a remote Pi employee unusable; asking the host about `claude`
    // on its behalf would refuse a desktop that has no Claude Code on it and
    // never needed any.
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    expect(await ensureRemoteHostReady(input(), "pi")).toEqual({ ok: true });
    expect(ensureRemoteReady).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ engine: "pi" }),
    );
  });

  it("lets a remote employee on Muse Code through, and asks the host about Muse's own CLI", async () => {
    // Muse Code runs on the host too, so a remote employee whose engine is
    // musecode (or that a fallback moved onto it) is not refused here.
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    expect(await ensureRemoteHostReady(input(), "musecode")).toEqual({ ok: true });
    expect(ensureRemoteReady).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ engine: "musecode" }),
    );
  });

  it("does not start the turn when a stop lands between the last probe and the restore", async () => {
    // `shouldAbort` covers the wait itself but cannot cover this window. The
    // restore is fenced on `waiting`, so it simply fails — and ignoring that
    // failure left the caller believing the session was running, spawning a
    // remote PTY for a turn nobody wanted.
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    (ensureRemoteReady as any).mockImplementationOnce(async (_t: any, _r: any, opts: any) => {
      opts.onWaitStart?.({ destination: "builder@build-box", waking: true });
      hoisted.status = "interrupted"; // the operator stops it here
      return { ready: true };
    });
    const res = await ensureRemoteHostReady(input(), "claude") as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stopped while waiting");
  });

  it("announces the wait and moves the session to waiting", async () => {
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    (ensureRemoteReady as any).mockImplementationOnce(async (_t: any, _r: any, opts: any) => {
      opts.onWaitStart?.({ destination: "builder@build-box", waking: true });
      return { ready: true };
    });
    await ensureRemoteHostReady(input(EMPLOYEE, { notifyWake: true }), "claude");
    expect(hoisted.updates[0].fields.status).toBe("waiting");
    expect(hoisted.notifications[0]).toContain("offline");
    expect(hoisted.updates[1].fields.status).toBe("running");
  });

  it("moves a turn waiting on the mount of a reachable host to waiting, and says so", async () => {
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    (ensureRemoteReady as any).mockImplementationOnce(async (_t: any, _r: any, opts: any) => {
      expect(opts.waitForMount).toBe(true);
      opts.onWaitStart?.({ destination: "builder@build-box", waking: false, waitingFor: "mount" });
      return { ready: true };
    });
    await ensureRemoteHostReady(input(EMPLOYEE, { notifyWake: true }), "claude");
    expect(hoisted.updates[0].fields).toMatchObject({ status: "waiting", lastError: "builder@build-box is up — waiting for the instance-home mount" });
    expect(hoisted.notifications[0]).toContain("instance-home mount is not ready yet");
    expect(hoisted.notifications[0]).not.toContain("offline");
    expect(hoisted.updates[1].fields.status).toBe("running");
  });

  it("reports an unreachable host as a refusal, not a silent stall", async () => {
    hoisted.readiness = { ready: false, reason: "build-box did not come up within 240s" };
    const res = await ensureRemoteHostReady(input(), "claude") as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("did not come up");
  });
});

describe("remote.notifyWake", () => {
  async function wakeThen(readiness: any, remote: Record<string, unknown>, waitingFor?: "host" | "mount") {
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    (ensureRemoteReady as any).mockImplementationOnce(async (_t: any, _r: any, opts: any) => {
      opts.onWaitStart?.({ destination: "builder@build-box", waking: true, waitingFor });
      return readiness;
    });
    return ensureRemoteHostReady(input(EMPLOYEE, remote), "claude");
  }

  it("decides on notifyWake alone, defaulting to off", () => {
    expect(shouldNotifyWake(undefined)).toBe(false);
    expect(shouldNotifyWake({})).toBe(false);
    expect(shouldNotifyWake({ notifyWake: false })).toBe(false);
    expect(shouldNotifyWake({ notifyWake: true })).toBe(true);
  });

  it("sends both notices when true", async () => {
    await wakeThen({ ready: true }, { notifyWake: true });
    expect(hoisted.notifications).toHaveLength(2);
    expect(hoisted.notifications[0]).toContain("offline");
    expect(hoisted.notifications[1]).toContain("is up");
  });

  it.each([
    ["unset", {}],
    ["false", { notifyWake: false }],
  ])("sends neither notice when %s, but still moves the session through waiting with its reason", async (_label, remote) => {
    const res = await wakeThen({ ready: true }, remote);
    expect(res).toEqual({ ok: true });
    expect(hoisted.notifications).toEqual([]);
    expect(hoisted.updates[0].fields).toMatchObject({ status: "waiting", lastError: "builder@build-box is offline — waking it" });
    expect(hoisted.updates[1].fields.status).toBe("running");
  });

  it("silences the mount-wait notice too by default, since it is the same wait", async () => {
    await wakeThen({ ready: true }, {}, "mount");
    expect(hoisted.notifications).toEqual([]);
    expect(hoisted.updates[0].fields.lastError).toContain("instance-home mount");
  });

  it("sends the mount-wait notice when true", async () => {
    await wakeThen({ ready: true }, { notifyWake: true }, "mount");
    expect(hoisted.notifications[0]).toContain("instance-home mount is not ready yet");
  });

  it.each([
    ["unset", {}],
    ["false", { notifyWake: false }],
  ])("keeps the failure notice on when %s: a host that will not wake needs the operator", async (_label, remote) => {
    const res = await wakeThen({ ready: false, reason: "build-box did not come up within 240s" }, remote) as any;
    expect(res.ok).toBe(false);
    expect(hoisted.notifications).toEqual(["❌ Remote host unavailable: build-box did not come up within 240s"]);
  });

  it("sends the wait notice and the failure notice when true", async () => {
    await wakeThen({ ready: false, reason: "build-box did not come up within 240s" }, { notifyWake: true });
    expect(hoisted.notifications).toHaveLength(2);
    expect(hoisted.notifications[1]).toContain("❌");
  });
});
