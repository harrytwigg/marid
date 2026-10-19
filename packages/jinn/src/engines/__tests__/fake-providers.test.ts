import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// claude-interactive.ts loads node-pty natively at import time; the classifiers under test have no PTY dependency.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../../shared/engine-reset-times.js", () => ({ claudeResetsAtSeconds: async () => undefined }));

import { rateLimitFromStopFailure, TurnResolver } from "../claude-interactive.js";
import { OpencodeTurn } from "../opencode-turn.js";
import { detectRateLimit, isRateLimitMessage } from "../../shared/rateLimit.js";
// The harness is plain ESM next to the verify scripts: the fakes themselves, not copies of them.
// @ts-expect-error untyped .mjs
import { claudeKeys, opencodeKeys, parseOutcome, pickOutcome, profileLabel, scenarioProblems } from "../../../../../scripts/fake-providers/scenario.mjs";
// @ts-expect-error untyped .mjs
import { stopFailurePayload } from "../../../../../scripts/fake-providers/claude-hooks.mjs";
// @ts-expect-error untyped .mjs
import { RATE_LIMIT_TEXT, RETRY_ABANDON_TEXT, modelsListing, runTurnLines } from "./fixtures/fake-opencode-scenario.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, "../../../../../scripts/fake-providers/fake-claude.mjs");
const FAKE_OPENCODE = path.join(here, "fixtures/fake-opencode.mjs");

describe("scenario parsing", () => {
  it("reads an outcome as a name or an object, and refuses anything else", () => {
    expect(parseOutcome("ok")).toEqual({ outcome: { outcome: "ok" } });
    expect(parseOutcome({ outcome: "rate-limit", resetsAt: 4_102_444_800 })).toEqual({ outcome: { outcome: "rate-limit", resetsAt: 4_102_444_800 } });
    expect(parseOutcome("explode").problem).toMatch(/unknown outcome "explode"/);
    expect(parseOutcome({ outcome: "rate-limit", resetsAt: "soon" }).problem).toMatch(/resetsAt/);
    expect(parseOutcome(null).problem).toMatch(/not an outcome/);
  });

  it("names every problem in a scenario document", () => {
    expect(scenarioProblems({ claude: { "a|opus": ["ok", "rate-limit"] }, opencode: { "p/m": "retry-abandon" } })).toEqual([]);
    expect(scenarioProblems({ claude: { "a|opus": [] }, grok: {}, opencode: { "p/m": "boom" } })).toEqual([
      'claude["a|opus"] lists no outcome',
      'unknown section "grok" (claude, opencode)',
      'opencode["p/m"]: unknown outcome "boom" (ok, rate-limit, hang, fail, signed-out, retry-abandon)',
    ]);
  });

  it("matches the exact key before the wildcards", () => {
    const scenario = { claude: { "*": "fail", "*|opus": "hang", "a|*": "signed-out", "a|opus": "rate-limit" } };
    const pick = (profile: string, model: string) => pickOutcome(scenario, "claude", claudeKeys(profile, model), []).outcome.outcome;
    expect(pick("a", "opus")).toBe("rate-limit");
    expect(pick("a", "sonnet")).toBe("signed-out");
    expect(pick("b", "opus")).toBe("hang");
    expect(pick("b", "sonnet")).toBe("fail");
    expect(pickOutcome({}, "claude", claudeKeys("a", "opus"), []).outcome.outcome).toBe("ok");
  });

  it("takes the nth item of a sequence by the ledger's count, and repeats the last", () => {
    const scenario = { claude: { "a|opus": ["rate-limit", "ok"] } };
    const rows = (n: number) => Array.from({ length: n }, () => ({ engine: "claude", scenarioKey: "a|opus", consumed: true }));
    const at = (n: number) => pickOutcome(scenario, "claude", claudeKeys("a", "opus"), rows(n)).outcome.outcome;
    expect([at(0), at(1), at(2), at(9)]).toEqual(["rate-limit", "ok", "ok", "ok"]);
    // A refused resume or a signed-out launch is in the ledger but takes no outcome.
    const unconsumed = [{ engine: "claude", scenarioKey: "a|opus", consumed: false }];
    expect(pickOutcome(scenario, "claude", claudeKeys("a", "opus"), unconsumed).outcome.outcome).toBe("rate-limit");
  });

  it("keys an opencode turn by provider/model and labels the gateway's own profile as default", () => {
    expect(opencodeKeys("x-provider/model-x")).toEqual(["x-provider/model-x", "x-provider/*", "*"]);
    expect(profileLabel(undefined)).toBe("default");
    expect(profileLabel("/h/.jinn-x/.claude-sandbox")).toBe("default");
    expect(profileLabel("/h/profile-a/")).toBe("profile-a");
  });
});

describe("the StopFailure the fake Claude sends", () => {
  const base = { sessionId: "sid", transcriptPath: "/t.jsonl", cwd: "/w" };

  it("is the payload the gateway maps to a rate limit", async () => {
    const payload = stopFailurePayload(base, "rate_limit", "limit", "limit");
    expect(payload).toMatchObject({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "sid", transcript_path: "/t.jsonl", cwd: "/w" });
    expect(await rateLimitFromStopFailure(payload)).toEqual({ status: "rejected", rateLimitType: "interactive_detected" });
  });

  it("settles a turn as the rate_limit failure the runner classifies", async () => {
    const resolver = new TurnResolver({ fallbackSessionId: "old" });
    resolver.onHook({ hook_event_name: "SessionStart", session_id: "sid" });
    resolver.onHook(stopFailurePayload(base, "rate_limit", "limit", "limit"));
    const settled = await resolver.promise;
    expect(settled.error).toMatch(/rate_limit/);
    expect(resolver.stopFailure?.error).toBe("rate_limit");
    expect(resolver.transcriptPath).toBe("/t.jsonl");
  });

  it("does not read as a rate limit for the other failures the fake sends", async () => {
    for (const error of ["authentication_failed", "max_output_tokens"]) {
      expect(await rateLimitFromStopFailure(stopFailurePayload(base, error, "x", "x"))).toBeNull();
    }
  });
});

describe("the limits the fake opencode reports", () => {
  const context = { sessionID: "ses_1", model: "p/m" };
  /** A run turn's lines through the real turn parser, as the adapter reads them. */
  function resultOf(outcome: object, version?: string) {
    const { lines, code } = runTurnLines(outcome, { ...context, version });
    const turn = new OpencodeTurn("");
    for (const line of lines) turn.readLine(JSON.stringify(line), null);
    return turn.result({ code, terminationReason: null, stderr: "" });
  }

  it("classifies the 1.x limit as a rate limit", () => {
    const result = resultOf({ outcome: "rate-limit" });
    expect(result.error).toBe(`APIError: ${RATE_LIMIT_TEXT}`);
    expect(result.rateLimit).toEqual({ status: "rejected" });
    expect(detectRateLimit(result).limited).toBe(true);
  });

  it("classifies the 2.x limit as a rate limit", () => {
    for (const result of [resultOf({ outcome: "rate-limit", form: "v2" }), resultOf({ outcome: "rate-limit" }, "v2:2.0.29")]) {
      expect(result.error).toBe(`provider.rate-limit: ${RATE_LIMIT_TEXT} (HTTP 429)`);
      expect(detectRateLimit(result).limited).toBe(true);
    }
  });

  it("classifies an abandoned far-off retry as a rate limit, and a plain failure as none", () => {
    expect(isRateLimitMessage(RETRY_ABANDON_TEXT)).toBe(true);
    expect(detectRateLimit(resultOf({ outcome: "retry-abandon" })).limited).toBe(true);
    const failure = resultOf({ outcome: "fail" });
    expect(failure.error).toMatch(/upstream exploded/);
    expect(detectRateLimit(failure).limited).toBe(false);
  });

  it("answers an ok turn with the model it ran on", () => {
    const result = resultOf({ outcome: "ok" });
    expect(result.result).toBe("fc-ok engine=opencode model=p/m mode=run");
    expect(result.error).toBeUndefined();
  });
});

describe("the fakes as processes", { timeout: 30_000 }, () => {
  let dir: string;
  const files = () => ({ scenario: path.join(dir, "scenario.json"), ledger: path.join(dir, "ledger.jsonl"), hooks: path.join(dir, "hooks.log") });
  const ledger = () => fs.readFileSync(files().ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const env = () => ({ PATH: process.env.PATH ?? "", HOME: dir, FAKE_PROVIDER_SCENARIO: files().scenario, FAKE_PROVIDER_LEDGER: files().ledger });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-providers-"));
    fs.mkdirSync(path.join(dir, "work"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A profile directory with the login file the gateway's sign-in check wants. */
  function profile(name: string): string {
    const configDir = path.join(dir, name);
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, ".credentials.json"), "{\"claudeAiOauth\":{}}\n");
    return configDir;
  }

  /** The settings --settings names: every hook appends its stdin to hooks.log. */
  function settings(): string {
    const hook = path.join(dir, "hook.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ncat >> ${files().hooks}\necho >> ${files().hooks}\n`, { mode: 0o755 });
    const entry = [{ hooks: [{ type: "command", command: hook }] }];
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: entry, UserPromptSubmit: entry, Stop: entry, StopFailure: entry } }));
    return file;
  }

  function runClaude(configDir: string, args: string[]) {
    return spawnSync(process.execPath, [FAKE_CLAUDE, "--settings", settings(), ...args], {
      cwd: path.join(dir, "work"), env: { ...env(), CLAUDE_CONFIG_DIR: configDir }, input: "", timeout: 8000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const hookEvents = () => fs.readFileSync(files().hooks, "utf8").trim().split("\n").map((line) => JSON.parse(line));

  it("files a limited turn with the StopFailure the gateway classifies, then answers after it", () => {
    fs.writeFileSync(files().scenario, JSON.stringify({ claude: { "profile-a|opus": ["rate-limit", "ok"] } }));
    const a = profile("profile-a");
    runClaude(a, ["--model", "opus", "--", "first fc-tag-one"]);
    const failure = hookEvents().find((event) => event.hook_event_name === "StopFailure");
    expect(failure).toMatchObject({ error: "rate_limit", session_id: expect.any(String) });
    expect(fs.existsSync(failure.transcript_path)).toBe(true);
    expect(failure.transcript_path.startsWith(path.join(a, "projects"))).toBe(true);

    runClaude(a, ["--model", "opus", "--", "again fc-tag-one"]);
    const [first, second] = ledger();
    expect([first.outcome, second.outcome]).toEqual(["rate-limit", "ok"]);
    expect(first).toMatchObject({ engine: "claude", profile: "profile-a", profileDir: a, model: "opus", tag: "fc-tag-one", resume: null });
    expect(hookEvents().map((event) => event.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "StopFailure", "SessionStart", "UserPromptSubmit", "Stop"]);
    expect(hookEvents().at(-1).last_assistant_message).toContain("profile=profile-a model=opus");
  });

  it("refuses to resume a conversation under another profile, and resumes it under its own", () => {
    fs.writeFileSync(files().scenario, "{}");
    const [a, b] = [profile("profile-a"), profile("profile-b")];
    runClaude(a, ["--model", "opus", "--", "hello"]);
    const thread = ledger()[0].sessionId;
    const refused = runClaude(b, ["--resume", thread, "--model", "sonnet", "--", "hello"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`No conversation found with session ID: ${thread}`);
    runClaude(a, ["--resume", thread, "--model", "sonnet", "--", "hello"]);
    expect(ledger().map((row) => [row.profile, row.model, row.outcome, row.resume])).toEqual([
      ["profile-a", "opus", "ok", null], ["profile-b", "sonnet", "resume-not-found", thread], ["profile-a", "sonnet", "ok", thread],
    ]);
  });

  it("fires an auth failure for a signed-out outcome and exits at once for a profile with no login", () => {
    fs.writeFileSync(files().scenario, JSON.stringify({ claude: { "*": "signed-out" } }));
    runClaude(profile("profile-a"), ["--", "hi"]);
    expect(hookEvents().find((event) => event.hook_event_name === "StopFailure")).toMatchObject({ error: "authentication_failed" });
    const bare = path.join(dir, "profile-b");
    fs.mkdirSync(bare);
    const result = runClaude(bare, ["--", "hi"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Not logged in");
  });

  it("runs an opencode turn by its -m model, writes the ledger and lists the scenario's models", () => {
    fs.writeFileSync(files().scenario, JSON.stringify({ opencode: { "x/limited": "rate-limit", "*": "ok" } }));
    const run = (model: string) => spawnSync(process.execPath, [FAKE_OPENCODE, "run", "--format", "json", "-m", model], { env: env(), input: "go fc-tag-two", encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"] });
    const limited = run("x/limited");
    expect(limited.status).toBe(1);
    expect(JSON.parse(limited.stdout.trim()).error.data.message).toBe(RATE_LIMIT_TEXT);
    expect(run("y/fine").status).toBe(0);
    expect(ledger().map((row) => [row.engine, row.mode, row.model, row.outcome, row.tag])).toEqual([
      ["opencode", "run", "x/limited", "rate-limit", "fc-tag-two"], ["opencode", "run", "y/fine", "ok", "fc-tag-two"],
    ]);
    const models = spawnSync(process.execPath, [FAKE_OPENCODE, "models"], { env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(models.stdout.split("\n")).toContain("x/limited");
    expect(modelsListing(true)).toContain("\"providerID\": \"opencode\"");
  });
});
