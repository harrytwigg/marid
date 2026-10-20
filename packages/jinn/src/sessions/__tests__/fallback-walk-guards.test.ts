import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Employee, Engine, JinnConfig } from "../../shared/types.js";
import { CLAUDE_B, DIR_B, OPENCODE_X, answer, authSeen, claudeProfileFromDir, config, employee, failed, handleRateLimit, hopsOf, key, limited, limitedTurn, maybeRevertEngineOverride, newSession, overrideOf, readEngineHealth, reg, resetsIn, runOf, scripted, setDepartmentScopeResolver, setEmployeeDepartmentResolver, signedOut, tmp, who, useWalkHarness } from "./fallback-walk-harness.js";

/** The fallback walk's guards: the loop guard, a revert, which failures move a link on, and scoped sessions. */

useWalkHarness();

describe("the loop guard", () => {
  it("never takes up a legacy cycle again: claude -> codex -> claude is claude once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cyclic = { ...config, engines: { ...config.engines, claude: { bin: "claude", model: "opus", fallback: ["codex"] }, codex: { bin: "codex", model: "gpt", fallback: ["claude"] } } } as unknown as JinnConfig;
    const { engines, calls } = scripted(() => limited());
    const id = newSession({ ref: "web:cycle", employeeName: "plain" });
    const { opts } = limitedTurn(id, { name: "plain", engine: "claude" } as Employee, engines);
    const outcome = handleRateLimit({ ...opts, config: cyclic });
    await vi.advanceTimersByTimeAsync(0);

    // The original engine is not a substitute for its own stand-in: codex is the only hop.
    expect(calls.map((call) => call.engine)).toEqual(["codex"]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("does not pick the original engine when a stand-in is limited in a later turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cyclic = { ...config, engines: { ...config.engines, claude: { bin: "claude", model: "opus", fallback: ["codex"] }, codex: { bin: "codex", model: "gpt", fallback: ["claude"] } } } as unknown as JinnConfig;
    const first = scripted((call) => (call.engine === "codex" ? answer("on codex", "codex-thread") : limited()));
    const id = newSession({ ref: "web:cycle-later", employeeName: "plain" });
    const plain = { name: "plain", engine: "claude" } as Employee;
    await handleRateLimit({ ...limitedTurn(id, plain, first.engines).opts, config: cyclic });
    reg.updateSession(id, { status: "idle" } as never);

    // The next turn runs on codex and is limited there: claude (the original) is not an answer.
    const second = scripted(() => limited());
    const turn = limitedTurn(id, plain, second.engines);
    const outcome = handleRateLimit({ ...turn.opts, config: cyclic });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.calls).toHaveLength(0);
    expect(turn.seen.waiting[0]!.hop).toMatchObject({ to: null });
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("continues a run across turns: the next limit moves on from where the session stands, never back to a target tried", async () => {
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    expect(runOf(id)).toMatchObject({ position: 1 });
    reg.updateSession(id, { status: "idle" } as never);

    // A is healthy again as far as the health store knows: the run still does not go back to it.
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    const second = scripted((call) => (who(call) === "x-provider/model-x" ? limited() : answer("on Y", "y-thread")));
    const outcome = await handleRateLimit(limitedTurn(id, employee(), second.engines).opts);

    expect(outcome.kind).toBe("fallback");
    expect(second.calls.map(who)).toEqual(["x-provider/model-x", "y-provider/model-y"]);
    expect(runOf(id)).toMatchObject({ position: 3 });
    const own = key({ engine: "claude", profile: "A", model: "opus" });
    expect(runOf(id)!.tried).toEqual([own, key(CLAUDE_B), key(OPENCODE_X)]);
    expect(hopsOf(id)).toHaveLength(3);
  });
});

describe("a revert", () => {
  it("clears the run and leaves the hops, and the next limit starts a fresh run", async () => {
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);
    expect(runOf(id)).toBeDefined();
    reg.updateSession(id, { status: "idle" } as never);

    // The window the swap was given has passed.
    const standing = (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>).engineOverride!;
    reg.updateSession(id, { transportMeta: { ...(reg.getSession(id)!.transportMeta as object), engineOverride: { ...standing, until: new Date(Date.now() - 1000).toISOString() } } } as never);
    const reverted = maybeRevertEngineOverride(reg.getSession(id)!);

    expect(reverted.engine).toBe("claude");
    expect(runOf(id)).toBeUndefined();
    expect(hopsOf(id)).toHaveLength(1);

    // Limited again: the run starts over from the own target, so B is tried again.
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    const again = scripted((call) => (who(call) === "B/sonnet" ? answer("on B again", "b-thread-2") : limited()));
    await handleRateLimit(limitedTurn(id, employee(), again.engines).opts);
    expect(again.calls.map(who)).toEqual(["B/sonnet"]);
    expect(runOf(id)).toMatchObject({ position: 1, tried: [key({ engine: "claude", profile: "A", model: "opus" })] });
    expect(hopsOf(id)).toHaveLength(2);
  });

  it("keeps only the newest 20 hops", async () => {
    const id = newSession();
    const old = Array.from({ length: 20 }, (_, i) => ({ at: new Date(i * 1000).toISOString(), from: "a", to: "b", fromLabel: "a", toLabel: "b", reason: "rate-limit" }));
    reg.updateSession(id, { transportMeta: { fallbackHops: old } } as never);
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? answer("on B") : limited()));
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const hops = hopsOf(id);
    expect(hops).toHaveLength(20);
    expect(hops[0]).toMatchObject({ to: key(CLAUDE_B) });
    expect(hops[19]).toMatchObject({ at: new Date(18_000).toISOString() });
  });
});

describe("failures that move a fallback link on, and the own target's that do not", () => {
  it("moves on from a link whose model the engine refuses, without holding it against the link's health", async () => {
    const { engines, calls } = scripted((call) => {
      if (who(call) === "B/sonnet") return failed("There's an issue with the selected model (sonnet). It may not exist or you may not have access to it. invalid model");
      return who(call) === "x-provider/model-x" ? answer("on X", "x-thread") : limited();
    });
    const id = newSession();
    const outcome = await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "on X" } });
    expect(calls.map(who)).toEqual(["B/sonnet", "x-provider/model-x"]);
    expect(hopsOf(id).map((hop) => hop.reason)).toEqual(["invalid-model", "rate-limit"]);
    expect(readEngineHealth()[`claude:${claudeProfileFromDir(DIR_B).key}`]).toBeUndefined();
  });

  it("moves on from a link whose Claude login is signed out, and lets the auth outage ledger record it", async () => {
    const { engines, calls } = scripted((call) => (who(call) === "B/sonnet" ? failed("API Error: authentication_failed") : who(call) === "x-provider/model-x" ? answer("on X") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    expect(calls.map(who)).toEqual(["B/sonnet", "x-provider/model-x"]);
    expect(hopsOf(id)[0]).toMatchObject({ reason: "auth" });
    expect(authSeen.errors).toEqual(["API Error: authentication_failed"]);
    // A signed-out login is not an exhausted account.
    expect(readEngineHealth()[`claude:${claudeProfileFromDir(DIR_B).key}`]).toBeUndefined();
  });

  it("passes over a profile that is signed out without launching it, and names why", async () => {
    signedOut.dirs.add(DIR_B);
    const { engines, calls } = scripted((call) => (who(call) === "x-provider/model-x" ? answer("on X") : limited()));
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);
    await handleRateLimit(opts);

    expect(calls.map(who)).toEqual(["x-provider/model-x"]);
    // The turn moved to B on paper and off it again: two hops, the second for the sign-in.
    expect(seen.starts.map((start) => start.hop?.reason)).toEqual(["rate-limit", "auth"]);
    expect(hopsOf(id).map((hop) => [hop.from, hop.to, hop.reason]).reverse()).toEqual([
      [key({ engine: "claude", profile: "A", model: "opus" }), key(CLAUDE_B), "rate-limit"],
      [key(CLAUDE_B), key(OPENCODE_X), "auth"],
    ]);
  });

  it("records the hops of a chain whose every link was passed over before the session ever moved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    signedOut.dirs.add(DIR_B);
    const { engines, calls } = scripted(() => limited());
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines);
    const outcome = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    expect(hopsOf(id).map((hop) => [hop.to, hop.reason]).reverse()).toEqual([[key(CLAUDE_B), "rate-limit"], [null, "auth"]]);
    // The session never left its own target, so there is no run and no override to show for it.
    expect(runOf(id)).toBeUndefined();
    expect(overrideOf(id)).toBeUndefined();
    expect(seen.waiting[0]!.reason).toMatch(/every target in its fallback chain was tried \(claude · B · sonnet\)/);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("does not move on from the session's own target: its model refusal is the turn's failure, not a hop", async () => {
    // The wait's retry runs the own target again; an invalid-model answer there settles the turn as it always did.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines } = scripted(() => limited());
    const id = newSession();
    const { opts } = limitedTurn(id, employee({ fallback: [] }), engines, { resetsAt: resetsIn(1) });
    const own = { name: "claude", async run() { return failed("invalid model: opus"); } } as unknown as Engine;
    const outcome = handleRateLimit({ ...opts, engine: own });
    await vi.advanceTimersByTimeAsync(40_000);

    expect(await outcome).toMatchObject({ kind: "resumed", result: { error: "invalid model: opus" } });
    expect(hopsOf(id)).toEqual([]);
  });
});

describe("scoped sessions", () => {
  it("skip a link that is not a Claude account, and say why in the hop", async () => {
    setDepartmentScopeResolver(() => "scoped");
    setEmployeeDepartmentResolver((name) => (name === "worker-a" ? "ops" : undefined));
    const { engines, calls } = scripted((call) => (who(call) === "C/opus" ? answer("on C", "c-thread") : limited()));
    const id = newSession();
    const chain = [OPENCODE_X, { engine: "claude", profile: "C", model: "opus" }];
    const outcome = await handleRateLimit(limitedTurn(id, employee({ fallback: chain }), engines).opts);

    expect(outcome.kind).toBe("fallback");
    expect(calls.map(who)).toEqual(["C/opus"]);
    expect(hopsOf(id)[0]).toMatchObject({ from: key({ engine: "claude", profile: "A", model: "opus" }), to: key(chain[1]!), reason: "rate-limit", skipped: [{ key: key(OPENCODE_X), reason: "scoped" }] });
    expect((reg.getSession(id)!.transportMeta as Record<string, unknown>).fallbackServedBy).toMatchObject({ key: key(chain[1]!) });
  });
});
