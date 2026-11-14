import { afterEach, describe, it, expect, vi } from "vitest";
import { enforcePtyIdleCap, LOCAL_HOST_KEY, ptyHostKey, ptyIdleCapForHost, PtyLifecycleManager } from "../pty-lifecycle.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("idle caps per host", () => {
  const tick = () => vi.advanceTimersByTime(1000);

  it("names a target's host: its remoteHost as written, else local", () => {
    expect(ptyHostKey({})).toBe(LOCAL_HOST_KEY);
    expect(ptyHostKey({ remoteHost: "  " })).toBe(LOCAL_HOST_KEY);
    expect(ptyHostKey({ remoteHost: "build-box" })).toBe("build-box");
  });

  it("gives a remote host its own entry, else maxLivePtys, and the gateway maxLivePtys alone", () => {
    const cfg = { maxLivePtys: 2, maxLivePtysByHost: { "build-box": 6, local: 99 } };
    expect(ptyIdleCapForHost(cfg, "local")).toBe(2);
    expect(ptyIdleCapForHost(cfg, "build-box")).toBe(6);
    expect(ptyIdleCapForHost(cfg, "other-box")).toBe(2);
    expect(ptyIdleCapForHost({}, "local")).toBe(8);
    expect(ptyIdleCapForHost({ maxLivePtysByHost: { x: Number.NaN } }, "x")).toBe(8);
  });

  it("reaps local idle PTYs stalest first, and never a running or viewed one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const claude = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const codex = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const running = fakeHandle(), viewed = fakeHandle(), oldest = fakeHandle(), middle = fakeHandle(), newest = fakeHandle();
    claude.adopt("running", running, { turnRunning: true });
    codex.adopt("viewed", viewed, { viewerCount: 1 });
    tick();
    claude.adopt("oldest", oldest);
    tick();
    codex.adopt("middle", middle);
    tick();
    claude.adopt("newest", newest);

    enforcePtyIdleCap([claude, codex], (host) => ptyIdleCapForHost({ maxLivePtys: 2 }, host));

    expect(oldest.killed).toBe(true);
    expect([middle.killed, newest.killed, running.killed, viewed.killed]).toEqual([false, false, false, false]);
  });

  it("counts a remote host's idle PTYs against that host, not the gateway's cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const m = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const remote = Array.from({ length: 5 }, () => fakeHandle());
    remote.forEach((h, i) => { m.adopt(`remote-${i}`, h, { hostKey: "build-box" }); tick(); });
    const local = [fakeHandle(), fakeHandle()];
    local.forEach((h, i) => { m.adopt(`local-${i}`, h); tick(); });

    // maxLivePtys 2 holds both local ones; build-box falls back to 2 as well.
    enforcePtyIdleCap([m], (host) => ptyIdleCapForHost({ maxLivePtys: 2 }, host));
    expect(local.map((h) => h.killed)).toEqual([false, false]);
    expect(remote.map((h) => h.killed)).toEqual([true, true, true, false, false]);

    // With its own entry the remote host keeps what it is allowed, the local cap unchanged.
    enforcePtyIdleCap([m], (host) => ptyIdleCapForHost({ maxLivePtys: 1, maxLivePtysByHost: { "build-box": 2 } }, host));
    expect(local.map((h) => h.killed)).toEqual([true, false]);
    expect(remote.slice(3).map((h) => h.killed)).toEqual([false, false]);
  });

  it("leaves a self-capped remote process out of the cap, but still caps the same pool's local ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const m = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const servers = Array.from({ length: 8 }, () => fakeHandle());
    servers.forEach((h, i) => { m.adopt(`srv-${i}`, h, { hostKey: "build-box", selfCapped: true }); tick(); });
    const local = Array.from({ length: 4 }, () => fakeHandle());
    local.forEach((h, i) => { m.adopt(`local-${i}`, h, { hostKey: LOCAL_HOST_KEY, selfCapped: false }); tick(); });

    enforcePtyIdleCap([m], (host) => ptyIdleCapForHost({ maxLivePtys: 2 }, host));

    expect(servers.some((h) => h.killed)).toBe(false);
    expect(local.map((h) => h.killed)).toEqual([true, true, false, false]);
  });

  it("isAtCapacity counts the gateway's own idle PTYs only", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 2, enforceLocalCap: false });
    m.adopt("r1", fakeHandle(), { hostKey: "build-box" });
    m.adopt("r2", fakeHandle(), { hostKey: "build-box" });
    m.adopt("l1", fakeHandle());
    expect(m.isAtCapacity()).toBe(false);
    m.adopt("l2", fakeHandle());
    expect(m.isAtCapacity()).toBe(true);
  });
});
