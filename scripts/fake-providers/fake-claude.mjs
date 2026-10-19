#!/usr/bin/env node
// Stand-in Claude Code for scripts/verify-fallback-chains.sh: the real interactive engine
// drives it through its PTY and the hooks named in --settings, as it drives the real CLI,
// and no provider is contacted. Modelled on scripts/verify-codename-upgrade-claude.cjs.
//
// What it does like the CLI: files each conversation as
// $CLAUDE_CONFIG_DIR/projects/<slug of the physical cwd>/<id>.jsonl, refuses to resume a
// conversation that is not under its own profile (so a Claude session id from one profile
// is never resumable under another), fires SessionStart / UserPromptSubmit / Stop through
// the settings' hooks, runs the settings' statusLine command with the account's windows,
// and on a limit fires StopFailure with `error: "rate_limit"`.
//
// What happens to a turn comes from the scenario file (FAKE_PROVIDER_SCENARIO), keyed by
// profile (CLAUDE_CONFIG_DIR) and model (--model): see ./scenario.mjs. Every turn is
// appended to the ledger (FAKE_PROVIDER_LEDGER). The profile is signed in when its
// `.credentials.json` holds anything, which is the check the gateway makes before a turn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendLedger, claudeKeys, loadScenario, pickOutcome, profileLabel, promptHead, promptMarks, promptTag,
} from "./scenario.mjs";
import {
  hookPayload, rateLimitMessage, statusLinePayload, stopFailurePayload, transcriptEntry,
} from "./claude-hooks.mjs";

const args = process.argv.slice(2);
const at = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "fake", subscriptionType: "fake" }));
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("Claude Code (fake provider)");
  process.exit(0);
}

const cwd = fs.realpathSync(process.cwd());
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const profile = profileLabel(configDir);
const model = at("--model") ?? "";
const resume = at("--resume");
const separator = args.indexOf("--");
const argvPrompt = separator >= 0 ? args.slice(separator + 1).join(" ") : "";
const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const scenario = loadScenario();
const settings = at("--settings") ? JSON.parse(fs.readFileSync(at("--settings"), "utf8")) : {};

const signedIn = () => {
  try {
    return fs.statSync(path.join(configDir, ".credentials.json")).size > 0;
  } catch {
    return false;
  }
};
const ledger = (row) => appendLedger({
  engine: "claude", profileDir: configDir, profile, model, resume: resume ?? null, cwd,
  jinnSession: process.env.JINN_SESSION_ID ?? null, ...row,
});

if (!signedIn()) {
  process.stdout.write("Not logged in · Please run /login\r\n");
  ledger({ outcome: "not-logged-in", promptHead: promptHead(argvPrompt), tag: promptTag(argvPrompt), consumed: false });
  process.exit(1);
}
if (resume && !fs.existsSync(path.join(projectDir, `${resume}.jsonl`))) {
  console.error(`No conversation found with session ID: ${resume}`);
  ledger({ outcome: "resume-not-found", promptHead: promptHead(argvPrompt), tag: promptTag(argvPrompt), consumed: false });
  process.exit(1);
}

fs.mkdirSync(projectDir, { recursive: true });
const sessionId = resume ?? crypto.randomUUID();
const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
const base = { sessionId, transcriptPath, cwd };
let turns = 0;
// A real CLI lives as long as its terminal. A stdin that ends (a test driving the fake without a PTY)
// ends the process once the argv prompt has been answered, unless the turn is a scripted hang.
let argvPending = Boolean(argvPrompt);
let hanging = false;
let stdinEnded = false;
const exitWhenDone = () => { if (stdinEnded && !argvPending && !hanging) process.exit(0); };

function fire(event, payload) {
  for (const matcher of settings.hooks?.[event] ?? []) {
    for (const hook of matcher.hooks ?? []) {
      spawnSync(hook.command, { shell: true, input: JSON.stringify(payload), stdio: ["pipe", "ignore", "ignore"], timeout: 15_000 });
    }
  }
}

function record(role, text, error = false) {
  const entry = transcriptEntry(role, text, { sessionId, cwd, model, uuid: crypto.randomUUID(), error });
  fs.appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
}

/** The statusline command, as the CLI runs it after a response: it files the account's windows. */
function statusLine(usedPercentage, resetsAt) {
  if (!settings.statusLine?.command) return;
  const payload = statusLinePayload({ sessionId, model, usedPercentage, resetsAt });
  spawnSync(settings.statusLine.command, { shell: true, input: JSON.stringify(payload), stdio: ["pipe", "ignore", "ignore"], timeout: 15_000 });
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function limited(outcome) {
  const resetsAt = outcome.resetsAt ?? inAnHour();
  const message = rateLimitMessage(resetsAt);
  record("assistant", message, true);
  statusLine(100, resetsAt);
  fire("StopFailure", stopFailurePayload(base, "rate_limit", message, message));
}

function failed(outcome, error, details) {
  const message = details ?? "fake provider failure";
  record("assistant", message, true);
  fire("StopFailure", stopFailurePayload(base, error, outcome.error ?? message, message));
}

function answered(text) {
  const reply = `fc-ok profile=${profile} model=${model || "default"} session=${sessionId}${text.startsWith("/") ? " (command)" : ""}`;
  record("assistant", reply);
  statusLine(12, inAnHour());
  fire("Stop", hookPayload("Stop", base, { last_assistant_message: reply }));
}

function turn(text) {
  const { outcome, scenarioKey, step } = pickOutcome(scenario, "claude", claudeKeys(profile, model));
  ledger({
    outcome: outcome.outcome, scenarioKey, step, consumed: true, warm: turns > 0, sessionId,
    promptHead: promptHead(text), tag: promptTag(text), marks: promptMarks(text),
  });
  turns += 1;
  record("user", text);
  fire("UserPromptSubmit", hookPayload("UserPromptSubmit", base, { prompt: text }));
  if (outcome.outcome === "hang") { hanging = true; return; }
  if (outcome.outcome === "rate-limit") limited(outcome);
  else if (outcome.outcome === "signed-out") failed(outcome, "authentication_failed", "Invalid API key · Please run /login");
  else if (outcome.outcome === "fail") failed(outcome, outcome.error ?? "max_output_tokens");
  else answered(text);
}

process.stdout.write("\x1b[2J\x1b[HClaude Code (fake provider)\r\n> ");
fire("SessionStart", hookPayload("SessionStart", base, { source: resume ? "resume" : "startup" }));
setTimeout(() => {
  if (argvPrompt) turn(argvPrompt);
  argvPending = false;
  exitWhenDone();
}, 400);

// Typed or pasted input: a bracketed paste is the prompt, and a CR outside one submits it.
let typed = "";
let pasting = false;
const KEYS = /\x1b\[200~|\x1b\[201~|\x1b\[[0-9;?]*[a-zA-Z~]|[\s\S]/g;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (/** @type {string} */ chunk) => {
  for (const key of chunk.match(KEYS) ?? []) {
    if (key === "\x1b[200~") pasting = true;
    else if (key === "\x1b[201~") pasting = false;
    else if (key.startsWith("\x1b")) continue;
    else if (!pasting && (key === "\r" || key === "\n")) {
      const text = typed.trim();
      typed = "";
      if (text) turn(text);
    } else typed += key;
  }
});
process.stdin.on("end", () => { stdinEnded = true; exitWhenDone(); });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
