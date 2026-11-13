import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { doctorFindings } from "../doctor.js";
import { collectOpencodeAccounts, opencodeAccountsFindings } from "../doctor-opencode-accounts.js";
import { invalidateModelRegistry, refreshOpencodeModels } from "../../shared/models.js";
import { clearOpencodeVersionCache } from "../../shared/opencode-bin-version.js";

/**
 * `jinn doctor` on opencode accounts (design, "Chain validation"): the account
 * problems that need the catalogue or the environment, and the chain links that
 * name a model or an account opencode does not serve. A fake `opencode` answers
 * `--version` and a catalogue as the 1.x or 2.x CLI would.
 */

const SENTINEL = "sentinel-key-value-0123456789";
const KEY_ENV = "DOCTOR_GO_B_KEY";
const OPENAI = "https://go.example.test/openai/v1";
const ANTHROPIC = "https://go.example.test/anthropic/v1";

const API_JSON = JSON.stringify({
  data: [
    { id: "alpha", providerID: "base-go", enabled: true, package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: OPENAI } },
    { id: "beta", providerID: "base-go", enabled: true, package: "@opencode/ai/providers/anthropic", settings: { baseURL: ANTHROPIC } },
  ],
});
const V1_TEXT = [["alpha", "@ai-sdk/openai-compatible", OPENAI], ["beta", "@ai-sdk/anthropic", ANTHROPIC]]
  .map(([id, npm, url]) => `base-go/${id}\n${JSON.stringify({ id, providerID: "base-go", api: { id, url, npm } }, null, 2)}`).join("\n");

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-oc-accounts-")); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  vi.unstubAllEnvs();
  await refreshOpencodeModels(configFor(path.join(dir, "missing")));
  invalidateModelRegistry();
  clearOpencodeVersionCache();
});

function fakeBin(name: string, generation: 1 | 2): string {
  fs.writeFileSync(path.join(dir, `${name}.json`), API_JSON);
  fs.writeFileSync(path.join(dir, `${name}.txt`), V1_TEXT);
  const version = generation === 2 ? "2.0.32" : "1.19.0";
  const answers = generation === 2
    ? `*--verbose*) exit 1;; "api model.list"*) cat '${dir}/${name}.json';;`
    : `*--verbose*) cat '${dir}/${name}.txt';; "api"*) exit 1;;`;
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$*" in --version) echo ${version};; ${answers} *) printf 'base-go/alpha\\n';; esac\n`, { mode: 0o755 });
  return bin;
}

function configFor(bin: string, over: { accounts?: Record<string, unknown>; fallback?: unknown[] } = {}): JinnConfig {
  return {
    gateway: {}, sessions: {},
    engines: { default: "claude", claude: { bin: "claude", fallback: over.fallback ?? [] }, opencode: { bin, ...(over.accounts ? { accounts: over.accounts } : {}) } },
  } as unknown as JinnConfig;
}
const account = (over: Record<string, unknown> = {}) => ({ b: { provider: "go-b", base: "base-go", keyEnv: KEY_ENV, ...over } });

describe.skipIf(process.platform === "win32")("collectOpencodeAccounts", () => {
  it("reads nothing for an instance with no account and no chain naming an opencode model", async () => {
    expect(await collectOpencodeAccounts(configFor(fakeBin("none", 2)))).toBeUndefined();
  });

  it("has nothing to say about a sound account with its key set", async () => {
    vi.stubEnv(KEY_ENV, SENTINEL);
    const reading = await collectOpencodeAccounts(configFor(fakeBin("sound", 2), { accounts: account(), fallback: [{ engine: "opencode", model: "go-b/alpha" }] }));
    expect(reading).toEqual({ accounts: 1, accountProblems: [], chainProblems: [] });
    expect(opencodeAccountsFindings(reading!)).toEqual([expect.objectContaining({ level: "ok" })]);
  });

  it("names a base that is not in the catalogue, an unknown subset model and a key that is not set", async () => {
    vi.stubEnv(KEY_ENV, "");
    const missing = await collectOpencodeAccounts(configFor(fakeBin("missing", 2), { accounts: account({ base: "nowhere" }) }));
    expect(missing?.accountProblems).toContain(`account "b": base "nowhere" is not in opencode's catalogue on this host`);
    expect(missing?.accountProblems).toContain(`account "b" has no key: ${KEY_ENV} is not set`);
    const subset = await collectOpencodeAccounts(configFor(fakeBin("subset", 2), { accounts: account({ models: ["alpha", "ghost"] }) }));
    expect(subset?.accountProblems).toContain(`account "b": model "ghost" is not one of base "base-go"'s models`);
  });

  it("names a provider id the catalogue already has, base present or not", async () => {
    vi.stubEnv(KEY_ENV, SENTINEL);
    const present = await collectOpencodeAccounts(configFor(fakeBin("collide", 2), { accounts: account({ provider: "base-go", base: "base-go-x" }) }));
    expect(present?.accountProblems).toContain(`account "b": provider "base-go" is already a provider in opencode's catalogue; pick an id no provider uses`);
    expect(present?.accountProblems).toContain(`account "b": base "base-go-x" is not in opencode's catalogue on this host`);
  });

  it("names the models a 1.x local binary leaves out, and none on 2.x", async () => {
    vi.stubEnv(KEY_ENV, SENTINEL);
    const one = await collectOpencodeAccounts(configFor(fakeBin("one", 1), { accounts: account() }));
    // On 1.x both models share one endpoint in this fake's records only if they do; here they differ, so one is left out.
    expect(one?.accountProblems).toEqual([expect.stringContaining("the local opencode is 1.x")]);
    expect(one?.accountProblems[0]).toMatch(/left out of the model list on this host, and a turn on one fails: (alpha|beta)$/);
    const two = await collectOpencodeAccounts(configFor(fakeBin("two", 2), { accounts: account() }));
    expect(two?.accountProblems).toEqual([]);
  });

  it("names the chain links that name a model no account or catalogue serves", async () => {
    vi.stubEnv(KEY_ENV, SENTINEL);
    const reading = await collectOpencodeAccounts(configFor(fakeBin("chains", 2), {
      accounts: account({ models: ["alpha"] }),
      fallback: [{ engine: "opencode", model: "go-b/beta" }, { engine: "opencode", model: "mystery/x" }, { engine: "opencode", model: "go-b/alpha" }],
    }));
    expect(reading?.chainProblems).toEqual([
      `engines.claude.fallback[0]: model "go-b/beta" is not served by account "b"`,
      `engines.claude.fallback[1]: provider "mystery" is not in opencode's catalogue or engines.opencode.accounts`,
    ]);
  });

  it("checks chains with no account declared, since a chain can name a provider opencode lacks", async () => {
    const reading = await collectOpencodeAccounts(configFor(fakeBin("chain-only", 2), { fallback: [{ engine: "opencode", model: "mystery/x" }] }));
    expect(reading).toMatchObject({ accounts: 0, accountProblems: [], chainProblems: [expect.stringContaining(`provider "mystery"`)] });
  });
});

describe("opencodeAccountsFindings and doctorFindings", () => {
  it("prints each problem as an ACTION finding, and no value of a key", () => {
    const findings = opencodeAccountsFindings({ accounts: 1, accountProblems: [`account "b" has no key: ${KEY_ENV} is not set`], chainProblems: ["engines.claude.fallback[0]: provider \"x\" is not in opencode's catalogue or engines.opencode.accounts"] });
    expect(findings.map((f) => f.level)).toEqual(["problem", "problem"]);
    expect(JSON.stringify(findings)).toContain(KEY_ENV);
    expect(JSON.stringify(findings)).not.toContain(SENTINEL);
  });

  it("joins the report only when a reading is given", () => {
    const base = doctorFindings({ env: {}, home: "/nowhere", instances: [] });
    const reading = { accounts: 2, accountProblems: [], chainProblems: [] };
    const withReading = doctorFindings({ env: {}, home: "/nowhere", instances: [], opencodeAccounts: reading });
    expect(withReading).toEqual([...base, ...opencodeAccountsFindings(reading)]);
    expect(withReading.at(-1)?.message).toContain("2 declared account(s)");
  });
});
