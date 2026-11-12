import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store freezes its path from JINN_HOME at import.
const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-health-opencode-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-health-opencode-test"),
}));

import type { JinnConfig } from "../config-types.js";
import { quotaHoldEndsAtSeconds, recordOpencodeFailure } from "../engine-health-opencode.js";
import { clearEngineHealthByOperator, isEngineExhausted, readEngineHealth, recordEngineServed } from "../engine-health.js";
import { publicHealth } from "../engine-health-store.js";
import { healthKeys, isLinkExhausted, linkHealth } from "../fallback-chain-health.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-11-12T10:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
const config = (opencode: Record<string, unknown> = {}) => ({ engines: { default: "claude", claude: {}, opencode } }) as unknown as JinnConfig;
const link = (model: string) => ({ engine: "opencode", model, account: "opencode" });
const record = (error: string, over: Partial<Parameters<typeof recordOpencodeFailure>[0]> = {}) =>
  recordOpencodeFailure({ healthKey: "opencode/opencode-go", model: "opencode-go/kimi-k2", error, config: config(), now: NOW, ...over });

const FUNDS = "provider.quota: Insufficient account funds (HTTP 402)";
const BALANCE = "provider.quota: Insufficient balance. Top up at https://opencode.ai/console/wrk_1/billing?credits=1. (HTTP 402)";
const USAGE = "provider.quota: Go usage limit exceeded (HTTP 429)";
const EXPIRED = "provider.auth: This API key has expired. Create a new API key in OpenCode Console. (HTTP 401)";
const NO_ACCESS = "provider.auth: Upstream request failed: Model access is disabled (HTTP 403)";
const REGION = "provider.auth: RegionError: DeepSeek models require region opt-in (HTTP 403)";

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});
afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("a spent subscription allowance (402)", () => {
  it.each([FUNDS, BALANCE])("holds the provider out for the re-probe interval: %s", (error) => {
    expect(record(error)).toBe(true);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "quota", until: at(60).toISOString(), model: "opencode-go/kimi-k2" });
    expect(isEngineExhausted(readEngineHealth(at(59)), "opencode/opencode-go", at(59))).toBe(true);
  });

  it("is tried again after the re-probe interval", () => {
    record(FUNDS);
    expect(isEngineExhausted(readEngineHealth(at(61)), "opencode/opencode-go", at(61))).toBe(false);
  });

  it("takes the configured interval", () => {
    record(FUNDS, { config: config({ reprobeMinutes: 15 }) });
    expect(readEngineHealth(NOW)["opencode/opencode-go"]?.until).toBe(at(15).toISOString());
  });

  it("is not recorded for a pay-as-you-go provider, whose billing handling stays the caller's", () => {
    expect(record(FUNDS, { healthKey: "opencode/openrouter", model: "openrouter/x" })).toBe(false);
    expect(record(FUNDS, { config: config({ subscriptionProviders: ["acme-plan"] }) })).toBe(false);
    expect(readEngineHealth(NOW)).toEqual({});
  });

  it("keeps a later reopening a window already stated", () => {
    record(USAGE, { resetsAt: at(180).getTime() / 1000 });
    record(FUNDS, { now: at(5) });
    expect(readEngineHealth(at(5))["opencode/opencode-go"]?.until).toBe(at(180).toISOString());
  });

  it("is lifted by a turn the provider then served", () => {
    record(FUNDS);
    recordEngineServed("opencode/opencode-go", at(1).getTime(), "opencode-go/kimi-k2", at(2));
    expect(isEngineExhausted(readEngineHealth(at(2)), "opencode/opencode-go", at(2))).toBe(false);
  });

  it("is lifted by the operator's clear", () => {
    record(FUNDS);
    expect(clearEngineHealthByOperator("opencode/opencode-go", at(1))?.failureClass).toBe("quota");
    expect(isEngineExhausted(readEngineHealth(at(1)), "opencode/opencode-go", at(1))).toBe(false);
  });
});

describe("a spent usage window (429)", () => {
  it("holds the provider until the reset it stated", () => {
    record(USAGE, { resetsAt: at(95).getTime() / 1000 });
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "quota", until: at(95).toISOString() });
  });

  it("holds the provider for the re-probe interval when it stated none", () => {
    record(USAGE);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "quota", until: at(60).toISOString() });
  });

  it("reads a usage limit with no provider type as one too, on a subscription provider", () => {
    expect(record("Go usage limit exceeded; try again at 2026-11-12T12:30:00Z", { resetsAt: Date.parse("2026-11-12T12:30:00Z") / 1000 })).toBe(true);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]?.until).toBe("2026-11-12T12:30:00.000Z");
  });

  it("ends the stand-in window with the hold", () => {
    record(FUNDS);
    expect(quotaHoldEndsAtSeconds("opencode/opencode-go", NOW)).toBe(at(60).getTime() / 1000);
    expect(quotaHoldEndsAtSeconds("opencode/other", NOW)).toBeUndefined();
    expect(quotaHoldEndsAtSeconds("opencode/opencode-go", at(61))).toBeUndefined();
  });
});

describe("an expired key (401)", () => {
  let data: string;
  const savedXdg = process.env.XDG_DATA_HOME;
  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "oc-auth-data-"));
    process.env.XDG_DATA_HOME = data;
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg;
    fs.rmSync(data, { recursive: true, force: true });
  });
  function storeCredential(updated: number): void {
    fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
    const db = new Database(path.join(data, "opencode", "opencode.db"));
    db.exec("CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
    db.exec("DELETE FROM credential");
    db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES ('cred_1', 'opencode-go', 'API key', 'sk-secret', NULL, 1, ?)").run(updated);
    db.close();
  }

  it("holds the whole provider out, as signed out, until its credential changes", () => {
    storeCredential(1000);
    record(EXPIRED);
    const held = readEngineHealth(NOW)["opencode/opencode-go"]!;
    expect(held).toMatchObject({ state: "exhausted", failureClass: "auth" });
    expect(held.until).toBeUndefined();
    expect(held.credentialFingerprint).toMatch(/^[0-9a-f]{32}$/);
    // A week on, with the same key, it is still out.
    const later = new Date(NOW.getTime() + 7 * 24 * 60 * MIN);
    expect(isEngineExhausted(readEngineHealth(later), "opencode/opencode-go", later)).toBe(true);

    storeCredential(2000);
    expect(isEngineExhausted(readEngineHealth(NOW), "opencode/opencode-go", NOW)).toBe(false);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ state: "ok", reason: "the credential changed" });
  });

  it("is cleared when the credential can no longer be read, since the record then says nothing reliable", () => {
    storeCredential(1000);
    record(EXPIRED);
    fs.rmSync(path.join(data, "opencode"), { recursive: true, force: true });
    expect(isEngineExhausted(readEngineHealth(NOW), "opencode/opencode-go", NOW)).toBe(false);
  });

  it("is held for a day when no credential identity can be read, so a wrong verdict heals", () => {
    record(EXPIRED);
    const held = readEngineHealth(NOW)["opencode/opencode-go"]!;
    expect(held).toMatchObject({ state: "exhausted", failureClass: "auth", until: at(24 * 60).toISOString() });
    expect(held.credentialFingerprint).toBeUndefined();
    expect(isEngineExhausted(readEngineHealth(at(24 * 60 - 1)), "opencode/opencode-go", at(24 * 60 - 1))).toBe(true);
    expect(isEngineExhausted(readEngineHealth(at(24 * 60 + 1)), "opencode/opencode-go", at(24 * 60 + 1))).toBe(false);
  });

  it("is held for a day, with no fingerprint, when the turn ran on a remote host", () => {
    storeCredential(1000);
    record(EXPIRED, { remote: true });
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ until: at(24 * 60).toISOString() });
    expect(readEngineHealth(NOW)["opencode/opencode-go"]?.credentialFingerprint).toBeUndefined();
  });

  it("keeps the fingerprint out of what leaves the process", () => {
    storeCredential(1000);
    record(EXPIRED);
    const stored = readEngineHealth(NOW)["opencode/opencode-go"]!;
    expect(publicHealth(stored)).not.toHaveProperty("credentialFingerprint");
    const shown = linkHealth({ health: readEngineHealth(NOW), now: NOW }, link("opencode-go/kimi-k2"));
    expect(shown).toMatchObject({ state: "exhausted", failureClass: "auth" });
    expect(JSON.stringify(shown)).not.toContain(stored.credentialFingerprint!);
  });

  it("holds a provider out whether or not it is a subscription", () => {
    expect(record(EXPIRED, { healthKey: "opencode/openrouter", model: "openrouter/x" })).toBe(true);
    expect(readEngineHealth(NOW)["opencode/openrouter"]).toMatchObject({ state: "exhausted", failureClass: "auth" });
  });
});

describe("a model the account cannot use (403)", () => {
  it.each([NO_ACCESS, REGION])("holds that model out, and not its provider: %s", (error) => {
    expect(record(error)).toBe(true);
    const health = readEngineHealth(NOW);
    expect(health["opencode/opencode-go"]).toBeUndefined();
    expect(health["opencode/opencode-go/kimi-k2"]).toMatchObject({ state: "exhausted", failureClass: "model-access", until: at(60).toISOString() });
    expect(isLinkExhausted(health, link("opencode-go/kimi-k2"), NOW)).toBe(true);
    // The provider's other models keep serving.
    expect(isLinkExhausted(health, link("opencode-go/glm-5"), NOW)).toBe(false);
  });

  it("shows why on the link's health", () => {
    record(NO_ACCESS);
    expect(linkHealth({ health: readEngineHealth(NOW), now: NOW }, link("opencode-go/kimi-k2"))).toMatchObject({ state: "exhausted", failureClass: "model-access", until: at(60).toISOString() });
  });

  it("records nothing when the turn's model is unknown, rather than holding a provider out for one model's refusal", () => {
    expect(record(NO_ACCESS, { model: undefined })).toBe(false);
    expect(readEngineHealth(NOW)).toEqual({});
  });
});

describe("healthKeys", () => {
  it("reads an opencode link under its provider, its model, and the engine", () => {
    expect(healthKeys(link("opencode-go/kimi-k2"))).toEqual(["opencode/opencode-go", "opencode/opencode-go/kimi-k2", "opencode"]);
    expect(healthKeys({ engine: "opencode", model: undefined, account: "opencode" })).toEqual(["opencode"]);
    expect(healthKeys({ engine: "claude", model: "opus", account: "claude" })).toEqual(["claude"]);
    expect(healthKeys({ engine: "codex", model: "gpt", account: "codex" })).toEqual(["codex"]);
  });
});

describe("a failure that is none of these", () => {
  it("is not recorded", () => {
    expect(record("provider.no-route: no route for model (HTTP 404)")).toBe(false);
    expect(record("the model returned an empty answer")).toBe(false);
    expect(readEngineHealth(NOW)).toEqual({});
  });
});
