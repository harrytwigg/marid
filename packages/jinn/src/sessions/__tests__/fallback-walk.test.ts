import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_A, CLAUDE_B, DIR_B, HOUR, OPENCODE_X, OPENCODE_Y, answer, claudeProfileFromDir, employee, handleRateLimit, hopsOf, key, limited, limitedTurn, newSession, overrideOf, readEngineHealth, reg, resetsIn, runOf, scripted, tmp, who, useWalkHarness } from "./fallback-walk-harness.js";

/** A rate-limited turn walks the session's fallback chain (docs/fallback-chains.md): hop after hop within the turn, each target once, each on its own profile and model, until one serves it or the chain runs out and the session waits on its own target. */

useWalkHarness();

describe("a four-link chain: claude/A/opus -> claude/B/sonnet -> opencode/X -> opencode/Y", () => {
  it("walks hop by hop within one turn, each link on its own engine, profile directory and model", async () => {
    const { engines, calls } = scripted((call) => (who(call) === "y-provider/model-y" ? answer("done on Y", "y-thread") : limited()));
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "done on Y" } });
    expect(calls.map((call) => [call.engine, call.profileDir, call.model])).toEqual([
      ["claude", DIR_B, "sonnet"], ["opencode", null, "x-provider/model-x"], ["opencode", null, "y-provider/model-y"],
    ]);
    expect(seen.starts.map((start) => start.substitute)).toEqual(["claude", "opencode", "opencode"]);
    expect(seen.completes).toEqual([{ engine: "opencode", model: "y-provider/model-y" }]);
    expect(hopsOf(id).map((hop) => [hop.from, hop.to, hop.reason]).reverse()).toEqual([
      [key({ engine: "claude", profile: "A", model: "opus" }), key(CLAUDE_B), "rate-limit"],
      [key(CLAUDE_B), key(OPENCODE_X), "rate-limit"],
      [key(OPENCODE_X), key(OPENCODE_Y), "rate-limit"],
    ]);
    expect(seen.starts.map((start) => start.hop?.to)).toEqual([key(CLAUDE_B), key(OPENCODE_X), key(OPENCODE_Y)]);
  });

  it("hands every attempt that did not serve the turn to the failed-attempt hook, with the notices it asked for", async () => {
    const { engines } = scripted((call) => (who(call) === "x-provider/model-x" ? answer("ok") : { ...limited(), notices: [`notice from ${who(call)}`] }));
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);
    await handleRateLimit(opts);

    expect(seen.failed.map((result) => result.notices)).toEqual([["notice from B/sonnet"]]);
  });

  it("records the run, the target the session stands on, and who served the turn", async () => {
    const { engines } = scripted((call) => (who(call) === "y-provider/model-y" ? answer("done on Y", "y-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const own = key({ engine: "claude", profile: "A", model: "opus" });
    expect(runOf(id)).toMatchObject({ source: "employee", position: 3, tried: [own, key(CLAUDE_B), key(OPENCODE_X)] });
    const row = reg.getSession(id)!;
    expect(row.engine).toBe("opencode");
    expect(row.model).toBe("y-provider/model-y");
    expect(overrideOf(id)).toMatchObject({ originalEngine: "claude", originalModel: "opus", substituteTarget: { engine: "opencode", model: "y-provider/model-y" } });
    expect(row.engineSessions?.opencode?.id).toBe("y-thread");
    expect((row.transportMeta as Record<string, unknown>).fallbackServedBy).toMatchObject({ key: key(OPENCODE_Y), label: "opencode · y-provider/model-y" });
  });

  it("names why each hop was made: a throttle, an allowance window, an engine giving up its own retries", async () => {
    const texts: Record<string, string> = { "B/sonnet": "429 Too Many Requests", "x-provider/model-x": "You've hit your usage limit", "y-provider/model-y": "overloaded; opencode would not retry it for 40 min" };
    const { engines } = scripted((call) => (who(call) === "z" ? answer("never") : limited(undefined, texts[who(call)] ?? "429 Too Many Requests")));
    const id = newSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const outcome = handleRateLimit(limitedTurn(id, employee(), engines).opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(hopsOf(id).map((hop) => hop.reason).reverse()).toEqual(["rate-limit", "rate-limit", "quota", "retry-exhausted"]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("holds each limit against the link that hit it: its account for Claude, its provider for opencode", async () => {
    const { engines } = scripted((call) => (who(call) === "y-provider/model-y" ? answer("ok") : limited(resetsIn(2 * HOUR))));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const health = readEngineHealth();
    expect(Object.keys(health).sort()).toEqual([ACCOUNT_A, `claude:${claudeProfileFromDir(DIR_B).key}`, "opencode/x-provider"].sort());
    expect(health["opencode/y-provider"]).toBeUndefined();
  });

  it("records a Claude hop's declared account on the override, so the thread and profile follow it", async () => {
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    expect(overrideOf(id)).toMatchObject({ originalAccount: ACCOUNT_A, substituteAccount: accountB, substituteConfigDir: DIR_B, substituteTarget: { engine: "claude", profile: "B", model: "sonnet" } });
    expect(reg.getSession(id)!.engineSessions?.[accountB]?.id).toBe("b-thread");
    // A's own thread is where it was.
    expect(reg.getSession(id)!.engineSessions?.[ACCOUNT_A]?.id).toBe("a-thread");
  });
});

describe("a chain that runs out", () => {
  async function exhausted() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = scripted(() => limited());
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);
    const outcome = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(0);
    return { id, calls, seen, outcome };
  }

  it("tries each target exactly once, then waits on the session's own target", async () => {
    const { id, calls, seen, outcome } = await exhausted();

    expect(calls.map(who)).toEqual(["B/sonnet", "x-provider/model-x", "y-provider/model-y"]);
    expect(reg.getSession(id)!.status).toBe("waiting");
    expect(seen.waiting).toHaveLength(1);
    expect(seen.waiting[0]!.exhausted).toEqual({ tried: ["claude · B · sonnet", "opencode · x-provider/model-x", "opencode · y-provider/model-y"], own: "claude · A · opus" });
    // The session's own words for it: whose limit, and when it reopens.
    expect(reg.getSession(id)!.lastError).toMatch(/^claude · A · opus usage limit, resumes .+\d\d:\d\d$/);
    expect(seen.waiting[0]!.reason).toMatch(/every target in its fallback chain was tried \(claude · B · sonnet, opencode · x-provider\/model-x, opencode · y-provider\/model-y\); waiting for claude · A · opus to reset/);
    // Nothing is tried a second time while it waits.
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toMatchObject({ kind: "cancelled" });
    expect(calls).toHaveLength(3);
  });

  it("puts the session back on its own target, ends the run, and records the walk's last hop with no target", async () => {
    const { id, outcome } = await exhausted();

    const row = reg.getSession(id)!;
    expect(row.engine).toBe("claude");
    expect(row.model).toBe("opus");
    expect(row.engineSessionId).toBe("a-thread");
    expect(overrideOf(id)).toBeUndefined();
    expect(runOf(id)).toBeUndefined();
    const hops = hopsOf(id);
    expect(hops).toHaveLength(4);
    expect(hops[0]).toMatchObject({ to: null, toLabel: null, fromLabel: "opencode · y-provider/model-y" });
    expect(hops.map((hop) => hop.to).reverse().slice(0, 3)).toEqual([key(CLAUDE_B), key(OPENCODE_X), key(OPENCODE_Y)]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("falls to the plain wait, with no hop and no reason, when the chain has nothing the session may use", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = scripted(() => limited());
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee({ fallback: [] }), engines);
    const outcome = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    expect(seen.waiting[0]).toEqual({ resumeAt: expect.any(Date), rateLimit: expect.anything() });
    expect(hopsOf(id)).toEqual([]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });
});

describe("a chain that runs out while a stand-in holds the session", () => {
  it("waits for the session's own target, which is when the override ends, and hands back there", async () => {
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    reg.updateSession(id, { status: "idle" } as never);
    // The own target reopens in a moment (its recorded limit with it); the stand-in's own limit would not lift for days.
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    const standing = (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>).engineOverride!;
    const until = new Date(Date.now() + 1500);
    reg.updateSession(id, { transportMeta: { ...(reg.getSession(id)!.transportMeta as object), engineOverride: { ...standing, until: until.toISOString() } } } as never);

    const second = scripted(() => limited(resetsIn(5 * 24 * HOUR)));
    const turn = limitedTurn(id, employee(), second.engines, { resetsAt: resetsIn(5 * 24 * HOUR) });
    const outcome = await handleRateLimit(turn.opts);

    expect(outcome.kind).toBe("handback");
    expect(Date.now()).toBeGreaterThanOrEqual(until.getTime());
    // The remaining links were tried once each on the way; the own target is not one of them.
    expect(second.calls.map(who)).toEqual(["x-provider/model-x", "y-provider/model-y"]);
    expect(turn.seen.waiting[0]!.hop).toMatchObject({ to: null, fromLabel: "opencode · y-provider/model-y" });
    const row = reg.getSession(id)!;
    expect(row.engine).toBe("claude");
    expect(overrideOf(id)).toBeUndefined();
    expect(runOf(id)).toBeUndefined();
    expect(hopsOf(id)[0]).toMatchObject({ to: null });
  }, 15_000);
});
