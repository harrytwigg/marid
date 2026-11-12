import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, Engine } from "../../shared/types.js";
import { answer, failed, handleRateLimit, limited, limitedTurn, newSession, reg, resetsIn, scripted, tmp, useWalkHarness } from "./fallback-walk-harness.js";
import { readStore, writeStore, type EngineHealth } from "../../shared/engine-health-store.js";

/**
 * Which machine an opencode provider's failure, or a turn it served, is about. A remote employee's turns run with that
 * host's key, allowance and model access: what they hit is recorded against that host, and a turn they serve says
 * nothing about this machine's key or the models this machine's account may use.
 */

useWalkHarness();

const GO = { engine: "opencode", model: "opencode-go/x" };
const GO_B = { engine: "opencode", model: "opencode-go-b/x" };
const ROUTER = { engine: "opencode", model: "openrouter/x" };
const FUNDS = "provider.quota: Insufficient account funds (HTTP 402)";
const EXPIRED = "provider.auth: This API key has expired. Create a new API key in OpenCode Console. (HTTP 401)";
const NO_ACCESS = "provider.auth: Upstream request failed: Model access is disabled (HTTP 403)";
const USAGE = "provider.quota: Go usage limit exceeded (HTTP 429)";
const HOST = "build-box";
const MIN = 60_000;

const local = (fallback = [GO_B, ROUTER]): Employee => ({ name: "worker-oc", engine: "opencode", model: GO.model, fallback }) as Employee;
const remote = (fallback = [GO_B, ROUTER]): Employee => ({ ...local(fallback), remoteHost: HOST, remoteUser: "ci", remoteCwd: "/work" }) as Employee;

// A credential is read from opencode's own database; these turns must never read the machine's real one.
beforeEach(() => {
  const data = path.join(tmp, "xdg-data");
  fs.mkdirSync(data, { recursive: true });
  vi.stubEnv("XDG_DATA_HOME", data);
  return () => vi.unstubAllEnvs();
});

function turn(who: Employee, engines: Map<string, Engine>, error: string, rateLimit: Record<string, unknown>) {
  const id = newSession({ ref: `web:hosts-${Math.random()}`, engine: "opencode", model: GO.model, employeeName: "worker-oc" });
  const { opts } = limitedTurn(id, who, engines);
  return { id, opts: { ...opts, rateLimit, originalResult: failed(error) } as typeof opts };
}

/** A record seen on this machine half an hour ago and due a re-probe, so a walk tries its link and the turn can clear it. */
function heldDueReprobe(key: string, failureClass: EngineHealth["failureClass"]): void {
  const now = Date.now();
  writeStore({
    ...readStore(),
    [key]: { state: "exhausted", failureClass, until: new Date(now + 60 * MIN).toISOString(), recheckAt: new Date(now - MIN).toISOString(), observedAt: new Date(now - 30 * MIN).toISOString(), reason: "held" },
  });
}

describe("a remote employee's opencode failure", () => {
  it("on its own link is recorded against its host", async () => {
    const { engines } = scripted((call) => answer(`served by ${call.model}`));
    const { opts } = turn(remote(), engines, EXPIRED, { refused: "auth" });

    await handleRateLimit(opts);

    expect(readStore()["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "auth", host: HOST });
  });

  it("on a link the walk hopped to is recorded against its host", async () => {
    const { engines } = scripted((call) => (call.model === GO_B.model ? failed(NO_ACCESS) : answer(`served by ${call.model}`)));
    const { opts } = turn(remote(), engines, FUNDS, { billing: true });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });

    expect(readStore()["opencode/opencode-go-b/x"]).toMatchObject({ state: "exhausted", failureClass: "model-access", host: HOST });
  });

  it("on the retry after a wait is recorded against its host", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = scripted((_call, n) => (n === 1 ? limited(resetsIn(20 * 60), USAGE) : answer("served after the wait")));
    const { opts } = turn(remote([]), engines, USAGE, { resetsAt: resetsIn(10 * 60) });
    // The retry runs on the session's own engine.
    const own = { ...opts, engine: engines.get("opencode")! };

    const outcome = handleRateLimit(own);
    for (let i = 0; i < 60 && calls.length < 2; i++) await vi.advanceTimersByTimeAsync(MIN);
    await outcome;

    expect(calls).toHaveLength(2);
    expect(readStore()["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "quota", host: HOST });
  });
});

describe("an opencode turn a fallback walk served", () => {
  it.each([
    ["this machine", local, "ok"],
    ["a remote host", remote, "exhausted"],
  ] as const)("on %s: this machine's dead key and refused model on that link are %s", async (_where, who, expected) => {
    heldDueReprobe("opencode/opencode-go-b", "auth");
    heldDueReprobe("opencode/opencode-go-b/x", "model-access");
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { opts } = turn(who(), engines, FUNDS, { billing: true });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go-b/x" } });
    expect(calls.map((call) => call.model)).toEqual([GO_B.model]);

    expect(readStore()["opencode/opencode-go-b"]?.state).toBe(expected);
    expect(readStore()["opencode/opencode-go-b/x"]?.state).toBe(expected);
  });
});

describe("an opencode turn the retry after a wait served", () => {
  it.each([
    ["this machine", local, "ok"],
    ["a remote host", remote, "exhausted"],
  ] as const)("on %s: this machine's refusal of the session's model is %s", async (_where, who, expected) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    heldDueReprobe("opencode/opencode-go/x", "model-access");
    const { engines, calls } = scripted(() => answer("served after the wait"));
    const { id, opts } = turn(who([]), engines, USAGE, { resetsAt: resetsIn(10 * 60) });
    const own = { ...opts, engine: engines.get("opencode")! };

    const outcome = handleRateLimit(own);
    for (let i = 0; i < 30 && calls.length < 1; i++) await vi.advanceTimersByTimeAsync(MIN);
    await outcome;

    expect(calls).toHaveLength(1);
    expect(reg.getSession(id)).toBeDefined();
    expect(readStore()["opencode/opencode-go/x"]?.state).toBe(expected);
  });
});
