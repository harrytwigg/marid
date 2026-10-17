#!/usr/bin/env node
// Stand-in Claude Code for scripts/verify-codename-upgrade.mjs.
//
// It files a conversation the way the real CLI does: as
// $CLAUDE_CONFIG_DIR/projects/<slug of the PHYSICAL working directory>/<id>.jsonl, and, like the real
// one, refuses to resume a conversation that is not under the key of the directory it was started in.
// That refusal is what a home or stage move has to survive; nothing else here is Claude's.
//
// It speaks to the gateway through the hooks named in --settings (SessionStart, UserPromptSubmit, Stop),
// answers each turn with a line that names the conversation and the directory, and logs what it saw to
// $CLAUDE_CONFIG_DIR/stand-in.log.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const args = process.argv.slice(2);
const at = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
// Beside the profile, not named by a variable of its own: a department-scoped session's environment carries only an allow-list.
const log = (message) => { if (process.env.CLAUDE_CONFIG_DIR) fs.appendFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "stand-in.log"), `${message}\n`); };

if (args.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
// The gateway probes the CLI with these; the real one answers and exits, so the stand-in must too.
if (args.includes("--help") || args[0] === "auth") { console.log(args[0] === "auth" ? "Logged in (stand-in)" : "Claude Code (stand-in)"); process.exit(0); }

const cwd = process.cwd();
const slug = (value) => value.replace(/[^a-zA-Z0-9]/g, "-");
const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(require("node:os").homedir(), ".claude"), "projects", slug(cwd));
const resume = at("--resume");
const forking = args.includes("--fork-session");
const printing = args.includes("--print");
const separator = args.indexOf("--");
const prompt = separator >= 0 ? args.slice(separator + 1).join(" ") : (at("-p") || "");

log(`spawn cwd=${cwd} resume=${resume ?? "-"} fork=${forking} print=${printing} project=${slug(cwd)}`);

if (resume && !fs.existsSync(path.join(projectDir, `${resume}.jsonl`))) {
  const message = `No conversation found with session ID: ${resume}`;
  log(`refused ${message} (looked in ${projectDir})`);
  console.error(message);
  process.exit(1);
}

fs.mkdirSync(projectDir, { recursive: true });
const append = (file, role, text) => fs.appendFileSync(file, `${JSON.stringify({ type: role, message: { content: text }, cwd })}\n`);

function forkConversation() {
  const id = crypto.randomUUID();
  fs.copyFileSync(path.join(projectDir, `${resume}.jsonl`), path.join(projectDir, `${id}.jsonl`));
  log(`forked ${resume} -> ${id}`);
  return id;
}

if (printing) {
  const id = forking ? forkConversation() : resume || crypto.randomUUID();
  process.stdout.write(`${JSON.stringify({ session_id: id, result: "ok" })}\n`);
  process.exit(0);
}

let sessionId = resume;
if (forking) sessionId = forkConversation();
else if (!sessionId) sessionId = crypto.randomUUID();
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
const settings = at("--settings") ? JSON.parse(fs.readFileSync(at("--settings"), "utf8")) : {};

function fire(event, extra) {
  for (const matcher of settings.hooks?.[event] ?? []) {
    for (const hook of matcher.hooks ?? []) {
      const payload = JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd, transcript_path: transcript, ...extra });
      try {
        execSync(hook.command, { input: payload, stdio: ["pipe", "ignore", "ignore"], timeout: 15000 });
        log(`fired ${event}`);
      } catch (error) {
        log(`hook ${event} failed: ${error.message}`);
      }
    }
  }
}

function turn(text) {
  const reply = text.startsWith("/compact")
    ? `compacted ${sessionId} in ${cwd}`
    : `ok ${sessionId} in ${cwd}`;
  append(transcript, "user", text);
  fire("UserPromptSubmit", { prompt: text });
  append(transcript, "assistant", reply);
  log(`turn ${JSON.stringify(text.slice(0, 600))} -> ${reply}`);
  fire("Stop", { last_assistant_message: reply });
}

process.stdout.write("\x1b[2J\x1b[HClaude Code (stand-in)\r\n> ");
fire("SessionStart", { source: resume ? "resume" : "startup" });
setTimeout(() => { if (prompt) turn(prompt); }, 400);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "").replace(/[\r\n]+$/, "").trim();
  if (text) turn(text);
});
setInterval(() => {}, 1000);
