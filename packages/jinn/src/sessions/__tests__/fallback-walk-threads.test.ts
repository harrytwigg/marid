import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";
import { ACCOUNT_A, CLAUDE_B, DIR_A, DIR_B, HOUR, OPENCODE_X, OPENCODE_Y, answer, catalogue, claudeProfileFromDir, employee, failed, handleRateLimit, hopsOf, limited, limitedTurn, newSession, overrideOf, readEngineHealth, reg, resetsIn, runOf, scripted, signedOut, tmp, who, useWalkHarness } from "./fallback-walk-harness.js";

/** What a fallback hop's thread carries (docs/fallback-chains.md, Context across a hop). */

useWalkHarness();

describe("what a hop's thread carries (docs/fallback-chains.md, Context across a hop)", () => {
  it("resumes the same thread, with the new model, for another model on the same account", async () => {
    const { engines, calls } = scripted((call) => answer(`on ${who(call)}`, "a-thread"));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee({ fallback: [{ engine: "claude", profile: "A", model: "sonnet" }] }), engines).opts);

    expect(calls).toEqual([{ engine: "claude", profileDir: DIR_A, model: "sonnet", resume: "a-thread", prompt: "now publish them" }]);
    expect(reg.getSession(id)!.engineSessionId).toBe("a-thread");
  });

  it("resumes the same opencode session, with the other provider's model, on an opencode provider hop", async () => {
    const { engines, calls } = scripted((call) => answer(`on ${who(call)}`, "oc-thread"));
    const id = newSession({ ref: "web:oc", employeeName: "oc-worker", engine: "opencode", model: "x-provider/model-x" });
    reg.recordEngineSessionId(id, "opencode", "oc-thread");
    const worker = { name: "oc-worker", engine: "opencode", fallback: [OPENCODE_Y] } as Employee;
    await handleRateLimit(limitedTurn(id, worker, engines).opts);

    expect(calls).toEqual([{ engine: "opencode", profileDir: null, model: "y-provider/model-y", resume: "oc-thread", prompt: "now publish them" }]);
  });

  it("hops from one provider to another for the same model, in the same opencode session, and records who served", async () => {
    const { engines, calls } = scripted((call) => (call.model === "openrouter/glm-5" ? answer("served", "oc-thread") : limited()));
    const id = newSession({ ref: "web:oc-provider", employeeName: "oc-worker", engine: "opencode", model: "opencode-go/glm-5" });
    reg.recordEngineSessionId(id, "opencode", "oc-thread");
    const worker = { name: "oc-worker", engine: "opencode", fallback: [{ engine: "opencode", model: "openrouter/glm-5" }] } as Employee;
    await handleRateLimit(limitedTurn(id, worker, engines).opts);

    expect(calls.map((call) => [call.model, call.resume])).toEqual([["openrouter/glm-5", "oc-thread"]]);
    expect(hopsOf(id).map((hop) => [hop.from, hop.to, hop.reason])).toEqual([["opencode||opencode-go/glm-5", "opencode||openrouter/glm-5", "rate-limit"]]);
    expect((reg.getSession(id)!.transportMeta as Record<string, unknown>).fallbackServedBy).toMatchObject({ key: "opencode||openrouter/glm-5" });
    // The limit is held against the provider that hit it, not the engine: the other provider's link stayed healthy.
    expect(Object.keys(readEngineHealth())).toEqual(["opencode/opencode-go"]);
  });

  it("resumes another account's own thread, with what it has not seen put in front", async () => {
    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    // B ran this conversation before and was last brought up to date at 10:00; A has taken turns since.
    const synced = "2026-10-19T10:00:00.000Z";
    reg.recordEngineSessionId(id, "claude", "b-old", { lastSyncedAt: synced });
    reg.updateSession(id, { engineSessions: { [ACCOUNT_A]: { id: "a-thread" }, [accountB]: { id: "b-thread", lastSyncedAt: synced } } } as never);
    const db = (await import("../../shared/db.js")).initDb();
    const insertAt = (role: string, content: string, at: string) => db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(`${role}-${content}`, id, role, content, Date.parse(at));
    insertAt("user", "an old question B saw", "2026-10-19T09:00:00.000Z");
    insertAt("assistant", "an old answer B saw", "2026-10-19T09:30:00.000Z");
    insertAt("user", "a question B has not seen", "2026-10-19T11:00:00.000Z");
    insertAt("assistant", "an answer B has not seen", "2026-10-19T11:30:00.000Z");
    insertAt("user", "now publish them", "2026-10-19T12:00:00.000Z");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines).opts);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.resume).toBe("b-thread");
    expect(calls[0]!.prompt).toContain("USER: a question B has not seen");
    expect(calls[0]!.prompt).toContain("ASSISTANT: an answer B has not seen");
    expect(calls[0]!.prompt).not.toContain("an old question B saw");
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\nnow publish them")).toBe(true);
    // The current message is asked once, not also as the transcript's last line.
    expect(calls[0]!.prompt.match(/now publish them/g)).toHaveLength(1);
  });

  it("starts fresh, with the conversation handed over, for another account with no thread, and never resumes one profile's id under another", async () => {
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "draft the release notes");
    reg.insertMessage(id, "assistant", "drafted on A");
    reg.insertMessage(id, "user", "now publish them");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines).opts);

    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[0]!.prompt).toMatch(/^Continue this conversation and respond to the last USER message\./);
    expect(calls[0]!.prompt).toContain("ASSISTANT: drafted on A");
    expect(calls[0]!.prompt).not.toContain("a-thread");
  });

  it("starts fresh on another engine with no thread, too", async () => {
    const { engines, calls } = scripted(() => answer("on X", "x-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "now publish them");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [OPENCODE_X] }), engines).opts);

    expect(calls[0]).toMatchObject({ engine: "opencode", resume: undefined });
    expect(calls[0]!.prompt).toMatch(/^Continue this conversation/);
  });
});

describe("an ordinary failure on a link is the turn's failure, not a service", () => {
  it("is handed back as the result, keeps the thread id the link minted, and does not record the link as having served", async () => {
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? { sessionId: "b-thread", result: "", error: "socket hang up ECONNRESET" } : limited()));
    const id = newSession();
    const outcome = await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { error: "socket hang up ECONNRESET" } });
    const row = reg.getSession(id)!;
    expect(row.engineSessions?.[`claude:${claudeProfileFromDir(DIR_B).key}`]?.id).toBe("b-thread");
    expect((row.transportMeta as Record<string, unknown>).fallbackServedBy).toBeUndefined();
  });
});

describe("what a run that ran out names", () => {
  async function standingOnB() {
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    reg.updateSession(id, { status: "idle" } as never);
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    return id;
  }

  it("includes the stand-in the turn started on, first, then each link tried in the walk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const id = await standingOnB();
    const { engines } = scripted(() => limited());
    const turn = limitedTurn(id, employee(), engines);
    const outcome = handleRateLimit(turn.opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(turn.seen.waiting[0]!.exhausted?.tried).toEqual(["claude · B · sonnet", "opencode · x-provider/model-x", "opencode · y-provider/model-y"]);
    expect(turn.seen.waiting[0]!.reason).toMatch(/was tried \(claude · B · sonnet, opencode · x-provider\/model-x, opencode · y-provider\/model-y\)/);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("names the stand-in alone when it was the chain's only link", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const only = employee({ fallback: [CLAUDE_B] });
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, only, first.engines).opts);
    reg.updateSession(id, { status: "idle" } as never);

    const turn = limitedTurn(id, only, scripted(() => limited()).engines);
    const outcome = handleRateLimit(turn.opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(turn.seen.waiting[0]!.exhausted?.tried).toEqual(["claude · B · sonnet"]);
    expect(turn.seen.waiting[0]!.reason).toMatch(/was tried \(claude · B · sonnet\)/);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });
});

describe("a session's own fallback target is one link", () => {
  async function standingOnBWithTarget(target: { engine: string; model: string }) {
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    reg.updateSession(id, { status: "idle", fallbackTarget: target } as never);
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    return id;
  }

  it("ends the walk when that link cannot be launched (its profile is signed out), instead of choosing it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    catalogue.value = { claude: { models: [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }] } };
    const id = await standingOnBWithTarget({ engine: "claude", model: "haiku" });
    signedOut.dirs.add(DIR_B);
    const { engines, calls } = scripted(() => limited());
    const turn = limitedTurn(id, employee(), engines);
    const outcome = handleRateLimit(turn.opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    expect(turn.seen.starts).toHaveLength(1);
    expect(turn.seen.waiting[0]!.reason).toBe("the chosen fallback claude (haiku) is signed out");
    expect(hopsOf(id).length).toBeLessThanOrEqual(4);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("says how the target failed: a model it does not serve is not 'limited too'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    catalogue.value = { codex: { models: [{ id: "gpt-mini" }] } };
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    reg.updateSession(id, { status: "idle", fallbackTarget: { engine: "codex", model: "gpt-mini" } } as never);
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });

    const { engines } = scripted((call) => (call.engine === "codex" ? failed("invalid model: gpt-mini") : limited()));
    const turn = limitedTurn(id, employee(), engines);
    const outcome = handleRateLimit(turn.opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(turn.seen.starts).toHaveLength(1);
    expect(turn.seen.waiting[0]!.reason).toBe("the chosen fallback codex (gpt-mini) does not serve this model");
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });
});

describe("an engine stand-in holds the session when the chain runs out", () => {
  it("hands back at the override's until, as an account stand-in does", async () => {
    const chain = employee({ fallback: [OPENCODE_X] });
    const first = scripted((call) => (who(call) === "x-provider/model-x" ? answer("on X", "x-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, chain, first.engines).opts);
    reg.updateSession(id, { status: "idle" } as never);
    expect(reg.getSession(id)!.engine).toBe("opencode");
    const standing = (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>).engineOverride!;
    const until = new Date(Date.now() + 1500);
    reg.updateSession(id, { transportMeta: { ...(reg.getSession(id)!.transportMeta as object), engineOverride: { ...standing, until: until.toISOString() } } } as never);

    const second = scripted(() => limited(resetsIn(5 * 24 * HOUR)));
    const outcome = await handleRateLimit(limitedTurn(id, chain, second.engines, { resetsAt: resetsIn(5 * 24 * HOUR) }).opts);

    expect(outcome.kind).toBe("handback");
    expect(Date.now()).toBeGreaterThanOrEqual(until.getTime());
    expect(second.calls).toHaveLength(0);
    const row = reg.getSession(id)!;
    expect(row).toMatchObject({ engine: "claude", model: "opus" });
    expect(overrideOf(id)).toBeUndefined();
    expect(runOf(id)).toBeUndefined();
  }, 15_000);
});
