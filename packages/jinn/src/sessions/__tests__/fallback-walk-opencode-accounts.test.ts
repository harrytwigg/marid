import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, JinnConfig } from "../../shared/types.js";
import { answer, config, failed, handleRateLimit, limitedTurn, newSession, readEngineHealth, scripted, tmp, useWalkHarness } from "./fallback-walk-harness.js";
import { isLinkExhausted } from "../../shared/fallback-chain-health.js";
import { opencodeAccountKeyEnvironment, resetOpencodeAccountKeysForTest, setOpencodeAccountKeyEnv } from "../../shared/child-env.js";
import { forgetOpencodeAccountsForTest, rememberOpencodeAccounts } from "../../shared/opencode-subscription.js";
import { collectOpencodeAccounts } from "../../shared/engine-limits-opencode-accounts.js";
import type { EngineLimitEngineSnapshot } from "../../shared/types.js";

/** An alias account of a subscription (opencode-go-b, base opencode-go) through the whole chain: its 402 holds it, later turns skip it with no request, its card says why, and a rotated key clears a dead-key record. */

useWalkHarness();

const KEY = "ALIAS_CHAIN_KEY";
const ALIAS = { engine: "opencode", model: "opencode-go-b/x" };
const GO = { engine: "opencode", model: "opencode-go/x" };
const ROUTER = { engine: "opencode", model: "openrouter/x" };
const FUNDS = "provider.quota: Insufficient account funds (HTTP 402)";
const EXPIRED = "provider.auth: This API key has expired. Create a new API key in OpenCode Console. (HTTP 401)";
const MIN = 60_000;
const accounts = { "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: KEY } };
const opencodeBefore = config.engines.opencode;

beforeEach(() => {
  const data = path.join(tmp, "xdg-data");
  fs.mkdirSync(data, { recursive: true });
  vi.stubEnv("XDG_DATA_HOME", data);
  (config.engines as { opencode: unknown }).opencode = { bin: "opencode", model: ALIAS.model, accounts };
  setOpencodeAccountKeyEnv([KEY], { [KEY]: "sk-first-key" });
  rememberOpencodeAccounts(config);
});

afterEach(() => {
  vi.unstubAllEnvs();
  (config.engines as { opencode: unknown }).opencode = opencodeBefore;
  resetOpencodeAccountKeysForTest();
  forgetOpencodeAccountsForTest();
});

const worker = (): Employee => ({ name: "worker-oc", engine: "opencode", model: GO.model, fallback: [ALIAS, ROUTER] }) as Employee;

function turn(engines: Parameters<typeof limitedTurn>[2], error: string, rateLimit: Record<string, unknown>, who = worker()) {
  const id = newSession({ ref: "web:oc-alias", engine: "opencode", model: who.model, employeeName: who.name });
  const t = limitedTurn(id, who, engines);
  return { ...t, opts: { ...t.opts, rateLimit, originalResult: failed(error), hooks: { ...t.opts.hooks, onBillingFailure: vi.fn() } } as typeof t.opts };
}

const engineSnapshot = { name: "opencode", available: true, status: "snapshot", models: [], buckets: [] } as unknown as EngineLimitEngineSnapshot;
const card = () => collectOpencodeAccounts(config as JinnConfig, engineSnapshot, { employees: [], env: opencodeAccountKeyEnvironment({}) })!.find((a) => a.account === "go-b")!;

describe("an alias account answering 402", () => {
  it("is held as quota, skipped by the next turn with no request sent, shown on its card, and the next link serves", async () => {
    // Turn 1: the stock provider is spent, the alias answers 402 too, the third link serves.
    const first = scripted((call) => (call.model === ALIAS.model ? failed(FUNDS) : answer(`served by ${call.model}`)));
    const before = Date.now();
    expect(await handleRateLimit(turn(first.engines, FUNDS, { billing: true }).opts)).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(first.calls.map((call) => call.model)).toEqual([ALIAS.model, ROUTER.model]);

    const held = readEngineHealth()["opencode/opencode-go-b"]!;
    expect(held).toMatchObject({ state: "exhausted", failureClass: "quota" });
    expect(Date.parse(held.until!) - before).toBeGreaterThanOrEqual(59 * MIN);
    expect(isLinkExhausted(readEngineHealth(), { ...ALIAS, account: "opencode" })).toBe(true);

    // Turn 2: the alias is passed over without a request.
    const second = scripted((call) => answer(`served by ${call.model}`));
    expect(await handleRateLimit(turn(second.engines, FUNDS, { billing: true }).opts)).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(second.calls.map((call) => call.model)).toEqual([ROUTER.model]);

    // The card says why and when it is next tried, and carries nothing of the key.
    const shown = card();
    expect(shown.lastFailure).toMatchObject({ class: "quota" });
    expect(shown.nextTryAt).toBe(held.until);
    expect(JSON.stringify(shown)).not.toContain("sk-first-key");
  });

  it("clears an auth record when the key is rotated, and keeps it while the key is the same", async () => {
    const { engines } = scripted((call) => (call.model === ALIAS.model ? failed(EXPIRED) : answer(`served by ${call.model}`)));
    await handleRateLimit(turn(engines, EXPIRED, { refused: "auth" }).opts);
    expect(readEngineHealth()["opencode/opencode-go-b"]).toMatchObject({ state: "exhausted", failureClass: "auth" });
    expect(card().lastFailure).toMatchObject({ class: "auth" });

    // The same key (a reload that changed nothing) leaves the record in force.
    setOpencodeAccountKeyEnv([KEY], { [KEY]: "sk-first-key" });
    expect(readEngineHealth()["opencode/opencode-go-b"]).toMatchObject({ state: "exhausted", failureClass: "auth" });

    // A reader that does not hold the key (the operator's shell: `jinn limits`, `jinn doctor`) cannot say it changed: the hold stands there.
    resetOpencodeAccountKeysForTest();
    expect(readEngineHealth()["opencode/opencode-go-b"]).toMatchObject({ state: "exhausted", failureClass: "auth" });
    setOpencodeAccountKeyEnv([KEY], { [KEY]: "sk-first-key" });

    // A new key reads the record as cleared, and the card drops the failure.
    setOpencodeAccountKeyEnv([KEY], { [KEY]: "sk-second-key" });
    expect(readEngineHealth()["opencode/opencode-go-b"]).toMatchObject({ state: "ok", reason: "the credential changed" });
    expect(isLinkExhausted(readEngineHealth(), { ...ALIAS, account: "opencode" })).toBe(false);
    expect(card().lastFailure).toBeUndefined();
  });
});
