import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorMessage, connectorStub, eventually, scriptedEngine } from "./helpers/turn-parity-harness.js";
import {
  HOUR, MINUTE, START, answer, fallbackConfig, fallbackExpiryHarness, limitedUntil,
} from "./helpers/fallback-expiry-harness.js";
import type { EngineResult } from "../../shared/types.js";

/**
 * A session a rate limit moved along its fallback chain goes back to its own
 * target on the first turn after that target reopens, whatever kind of link it
 * was standing on: another Claude account, another model, a chain of several
 * links, an opencode provider. A target still limited at the reset keeps the
 * session where it is. Engine-to-engine returns are in engine-fallback-expiry.
 */

const { registry, reset, settled, override } = await fallbackExpiryHarness("jinn-fallback-return-");
const { SessionManager } = await import("../manager.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");

beforeEach(reset);
afterEach(() => vi.useRealTimers());

const claudeWorker = { name: "a-worker", engine: "claude", model: "opus", persona: "Return fixture" };
const opencodeWorker = { name: "an-opencode-worker", engine: "opencode", model: "alpha/big", persona: "Return fixture" };

/** A declared, signed-in Claude profile the chain can hop onto. */
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-return-profile-"));
fs.writeFileSync(path.join(profileDir, ".credentials.json"), "{\"signedIn\":true}");

interface Seen {
  model?: string;
  resume?: string;
}

/** A session manager over one scripted engine (claude or opencode) that records what each run was asked. */
function build(engineName: "claude" | "opencode", chain: unknown[], script: EngineResult[]) {
  const cfg = fallbackConfig() as any;
  cfg.engines.claude = { bin: process.execPath, model: "opus", accounts: { work: { configDir: profileDir } }, ...(engineName === "claude" ? { fallback: chain } : {}) };
  cfg.engines.opencode = { bin: process.execPath, model: "alpha/big", ...(engineName === "opencode" ? { fallback: chain } : {}) };
  cfg.models.claude = { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }] };
  cfg.models.opencode = { default: "alpha/big", models: [{ id: "alpha/big" }, { id: "alpha/small" }, { id: "beta/big" }] };
  const engine: any = scriptedEngine(engineName, script);
  const seen: Seen[] = [];
  const run = engine.run;
  engine.run = async (opts: Seen) => {
    seen.push({ model: opts.model, resume: opts.resume ?? (opts as any).resumeSessionId });
    return run(opts);
  };
  const manager = new SessionManager(cfg, new Map([[engineName, engine]]) as never, "return-boot");
  return { manager, seen };
}

async function turn(manager: InstanceType<typeof SessionManager>, key: string, text: string, worker: object = claudeWorker): Promise<string> {
  const answers = (id: string) => registry.getMessages(id).filter((m) => m.role === "assistant").length;
  const existing = registry.getSessionBySessionKey(key);
  const before = existing ? answers(existing.id) : 0;
  const routed = await manager.route(connectorMessage(key, text), connectorStub(), { employee: worker as never });
  const id = routed!.sessionId;
  await eventually(() => answers(id) > before && settled(id));
  return id;
}

const at = (ms: number) => vi.setSystemTime(new Date(START.getTime() + ms));
const accountLink = [{ engine: "claude", profile: "work", model: "sonnet" }];

describe("a session on another Claude account", () => {
  it("goes back to its own account on the first turn after the reset, resuming its own thread", async () => {
    const { manager, seen } = build("claude", accountLink, [
      answer("first", "own-thread"), limitedUntil(new Date(START.getTime() + HOUR)), answer("on work", "work-thread"),
      answer("on work again", "work-thread"), answer("back", "own-thread-2"),
    ]);
    const key = "stub:return-account";
    const id = await turn(manager, key, "one");
    await turn(manager, key, "two");
    expect(registry.getSession(id)!.model).toBe("sonnet");
    expect(override(id)).toMatchObject({ originalAccount: "claude", originalModel: "opus" });

    at(30 * MINUTE);
    await turn(manager, key, "three");
    expect(seen.at(-1)).toEqual({ model: "sonnet", resume: "work-thread" });

    at(2 * HOUR);
    await turn(manager, key, "four");
    expect(seen.at(-1)).toEqual({ model: "opus", resume: "own-thread" });
    expect(registry.getSession(id)!.model).toBe("opus");
    expect(override(id)).toBeUndefined();
  }, 30_000);

  it("starts a fresh thread, not the substitute's, when the session began on the substitute", async () => {
    const reset = new Date(START.getTime() + HOUR);
    recordEngineUnavailable("claude", "usage limit", Math.floor(reset.getTime() / 1000));
    const { manager, seen } = build("claude", accountLink, [answer("on work", "work-thread"), answer("on work again", "work-thread"), answer("back", "own-thread")]);
    const key = "stub:return-account-born";
    const id = await turn(manager, key, "one");
    expect(seen).toEqual([{ model: "sonnet", resume: undefined }]);
    expect(override(id)).toMatchObject({ originalAccount: "claude", originalEngineSessionId: null });

    at(2 * HOUR);
    await turn(manager, key, "two");
    // The own account never had a thread: it is not handed the work account's.
    expect(seen.at(-1)).toEqual({ model: "opus", resume: undefined });
    expect(override(id)).toBeUndefined();
  }, 30_000);

  it("stays on the substitute while the own account is recorded as still limited, then goes back", async () => {
    const firstReset = new Date(START.getTime() + HOUR);
    const { manager, seen } = build("claude", accountLink, [
      limitedUntil(firstReset), answer("on work", "work-thread"), answer("on work 2", "work-thread"), answer("on work 3", "work-thread"), answer("back", "own-thread"),
    ]);
    const key = "stub:return-account-still-limited";
    const id = await turn(manager, key, "one");
    expect(seen).toHaveLength(2);

    // Another session's probe found the account still limited, and recorded when it reopens.
    at(2 * HOUR);
    const secondReset = new Date(START.getTime() + 4 * HOUR);
    recordEngineUnavailable("claude", "usage limit", Math.floor(secondReset.getTime() / 1000));
    await turn(manager, key, "two");
    // No probe of the own account: the turn went straight to the substitute.
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)!.model).toBe("sonnet");
    expect(Date.parse(String(override(id)!.until))).toBe(secondReset.getTime());

    at(5 * HOUR);
    await turn(manager, key, "three");
    expect(seen.at(-1)!.model).toBe("opus");
    expect(override(id)).toBeUndefined();
  }, 30_000);
});

describe("a session on another model of its own account", () => {
  it("goes back to its own model on the first turn after the reset, on the same thread", async () => {
    const { manager, seen } = build("claude", [{ engine: "claude", model: "sonnet" }], [
      answer("first", "thread"), limitedUntil(new Date(START.getTime() + HOUR)), answer("on sonnet", "thread"), answer("on sonnet again", "thread"), answer("back", "thread"),
    ]);
    const key = "stub:return-model";
    const id = await turn(manager, key, "one");
    await turn(manager, key, "two");
    expect(registry.getSession(id)!.model).toBe("sonnet");

    at(30 * MINUTE);
    await turn(manager, key, "three");
    expect(seen.at(-1)).toEqual({ model: "sonnet", resume: "thread" });

    at(2 * HOUR);
    await turn(manager, key, "four");
    expect(seen.at(-1)).toEqual({ model: "opus", resume: "thread" });
    expect(override(id)).toBeUndefined();
  }, 30_000);
});

describe("a session that walked several links", () => {
  it("goes straight back to its own target, not to the first link, once its reset passes", async () => {
    const reset = new Date(START.getTime() + 2 * HOUR);
    const { manager, seen } = build("claude", [{ engine: "claude", model: "sonnet" }, { engine: "claude", model: "haiku" }], [
      answer("first", "thread"), limitedUntil(reset), limitedUntil(new Date(START.getTime() + 30 * MINUTE)), answer("on haiku", "thread"), answer("on haiku again", "thread"), answer("back", "thread"),
    ]);
    const key = "stub:return-two-hops";
    const id = await turn(manager, key, "one");
    await turn(manager, key, "two");
    expect(registry.getSession(id)!.model).toBe("haiku");
    // The first link reopens long before the own target; that is not a reason to leave the stand-in for it.
    at(HOUR);
    await turn(manager, key, "three");
    expect(seen.at(-1)!.model).toBe("haiku");
    expect(Date.parse(String(override(id)!.until))).toBe(reset.getTime());

    at(3 * HOUR);
    await turn(manager, key, "four");
    expect(seen.at(-1)).toEqual({ model: "opus", resume: "thread" });
    expect(override(id)).toBeUndefined();
  }, 30_000);
});

describe("an opencode session on another provider's model", () => {
  const chain = [{ engine: "opencode", model: "beta/big" }];

  it("goes back to its own model after the reset", async () => {
    const { manager, seen } = build("opencode", chain, [
      answer("first", "oc-thread"), limitedUntil(new Date(START.getTime() + HOUR)), answer("on beta", "oc-thread"), answer("on beta again", "oc-thread"), answer("back", "oc-thread"),
    ]);
    const key = "stub:return-opencode";
    const id = await turn(manager, key, "one", opencodeWorker);
    await turn(manager, key, "two", opencodeWorker);
    expect(registry.getSession(id)!.model).toBe("beta/big");
    at(30 * MINUTE);
    await turn(manager, key, "three", opencodeWorker);
    expect(seen.at(-1)!.model).toBe("beta/big");

    at(2 * HOUR);
    await turn(manager, key, "four", opencodeWorker);
    expect(seen.at(-1)!.model).toBe("alpha/big");
    expect(override(id)).toBeUndefined();
  }, 30_000);

  it("stays on the other provider while its own provider is recorded as still limited", async () => {
    const { manager, seen } = build("opencode", chain, [
      limitedUntil(new Date(START.getTime() + HOUR)), answer("on beta", "oc-thread"), answer("on beta 2", "oc-thread"), answer("on beta 3", "oc-thread"), answer("back", "oc-thread"),
    ]);
    const key = "stub:return-opencode-still-limited";
    const id = await turn(manager, key, "one", opencodeWorker);
    expect(seen).toHaveLength(2);

    at(2 * HOUR);
    const secondReset = new Date(START.getTime() + 4 * HOUR);
    // The limit is held against the provider, not the engine.
    recordEngineUnavailable("opencode/alpha", "usage limit", Math.floor(secondReset.getTime() / 1000));
    await turn(manager, key, "two", opencodeWorker);
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)!.model).toBe("beta/big");
    expect(Date.parse(String(override(id)!.until))).toBe(secondReset.getTime());

    at(5 * HOUR);
    await turn(manager, key, "three", opencodeWorker);
    expect(seen.at(-1)!.model).toBe("alpha/big");
    expect(override(id)).toBeUndefined();
  }, 30_000);
});
