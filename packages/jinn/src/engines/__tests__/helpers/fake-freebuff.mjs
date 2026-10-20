#!/usr/bin/env node
// A stand-in for the Freebuff TUI: it draws the same screens (idle, busy, the
// /model picker, a finished turn, the sign-in screen), takes a bracketed paste
// and Enter, and writes its chat files where the real CLI does. Enough of the
// real thing for the engine's whole turn to run against a real PTY.
//
//   FAKE_BUSY_MS     how long a turn stays busy (default 700)
//   FAKE_MODE        "signed-out" shows the sign-in screen on the first message
//   FAKE_HOURS       the hours balance on the panel (default 17); 0 = none left
//   FAKE_RELEASED_ONCE  a file path: the first process to start (no such file yet) shows the
//                    "session was released" message, creates the file, and every later one is fine
//   FAKE_START_LOG   a file each start and each Enter on the sign-in screen is appended to
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cwd = flag("--cwd") ?? process.cwd();
const continueId = flag("--continue");
const busyMs = Number(process.env.FAKE_BUSY_MS ?? 700);
const hours = process.env.FAKE_HOURS ?? "17";
const log = (line) => { if (process.env.FAKE_START_LOG) fs.appendFileSync(process.env.FAKE_START_LOG, `${line}\n`); };
log(`start pid=${process.pid} continue=${continueId ?? "none"}`);

const MODELS = [
  { label: "DeepSeek V4.1 Flash 10/17", efforts: ["high", "medium", "low"], x: 3 },
  { label: "MiMo v2.6 Flash Slow", x: 1 },
  { label: "MiMo v2.6 Flash Fast", x: 2 },
  { label: "Muse Spark 1.3", efforts: ["high", "low"], x: 3 },
];
let model = { ...MODELS[0], effort: 0 };
const project = path.basename(cwd);
const chatsDir = path.join(os.homedir(), ".config", "manicode", "projects", project, "chats");
const chatId = continueId ?? new Date().toISOString().replace(/:/g, "-");
const chatDir = path.join(chatsDir, chatId);
fs.mkdirSync(chatDir, { recursive: true });
fs.writeFileSync(path.join(chatDir, "log.jsonl"), "");
let messages = [];
try { messages = JSON.parse(fs.readFileSync(path.join(chatDir, "chat-messages.json"), "utf8")); } catch { /* new chat */ }
let started = messages.length > 0;
let title = "New chat";
let screen = "idle";
let answer = "";
let busyFor = 0;
let typed = "";
let pasted = "";
let inPaste = false;
let picker = 0;
let minutes = 60;
let notice = "";
if (process.env.FAKE_RELEASED_ONCE && !fs.existsSync(process.env.FAKE_RELEASED_ONCE)) {
  fs.writeFileSync(process.env.FAKE_RELEASED_ONCE, "");
  notice = "This session was released. Choose a model to start a new session.";
}

const draw = (lines) => process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n"));
const effortOf = () => (model.efforts ? ` • ${model.efforts[model.effort]}` : "");
const statusBar = () => ` ${model.label}${effortOf()} · ${cwd} · /model to change · Chat: ${title}`;
const panel = () => [" ┌────────────────────────┐", ` │ ${started ? "Session active" : "Your first message starts the session."}`.padEnd(27) + "│", ` │ ${hours}/21 hours remaining`.padEnd(27) + "│", " └────────────────────────┘"];
const input = (placeholder) => ["╭──────────────────────────────╮", "│                              │", `│  ▍${placeholder}`.padEnd(31) + "│", "╰──────────────────────────────╯"];

function render() {
  if (screen === "signed-out") return draw(["", "            Open this URL in your browser to login:", "  https://example.invalid/login", "            Waiting for login..."]);
  if (screen === "picker") {
    const rows = MODELS.flatMap((m, i) => {
      const e = i === picker ? model.efforts && m.label === model.label ? ` • ${model.efforts[model.effort]}` : m.efforts ? ` • ${m.efforts[0]}` : "" : m.efforts ? ` • ${m.efforts[0]}` : "";
      return [" ┌──────────────────────────────────────┐", ` │ ${i === picker ? "›" : " "} ${m.label}${e} · blurb`.padEnd(41) + "│", ` │ ${m.x}x`.padEnd(41) + "│", " └──────────────────────────────────────┘"];
    });
    return draw([` ${minutes}m left      ✕ End session`, " ↑↓ choose model · Tab reasoning · Enter select · Esc cancel", ...rows, statusBar()]);
  }
  const conversation = messages.length ? ["", "   [05:00 PM]", `   ${lastUser()}`, "", ...(screen === "idle" || screen === "busy" ? [`  ${answer}`] : []), ""] : [];
  if (screen === "busy") return draw([...panel(), ...conversation, ` working...${" ".repeat(60)}${Math.floor(busyFor / 1000)}s  ■ Esc`, ...input("Add to the current task (/ for commands)"), statusBar()]);
  const footer = messages.length && answer ? [`${" ".repeat(60)}⎘ • 2s • △▽`, ` ${minutes}m left · 13.5K (1%)      ✕ End session`] : [` ${minutes}m left      ✕ End session`];
  return draw([...panel(), ...conversation, ...(notice ? ["", `  ${notice}`] : []), ...footer, ...input("Enter a coding task or / for commands"), statusBar()]);
}

const lastUser = () => { const u = [...messages].reverse().find((m) => m.variant === "user"); return (u?.content || u?.textAttachments?.[0]?.content || "").slice(0, 80).replace(/\n/g, " "); };

function submit(text) {
  if (process.env.FAKE_MODE === "signed-out") { screen = "signed-out"; return render(); }
  started = true;
  const long = text.length > 500 || text.includes("\n");
  messages.push({ id: `user-${Date.now()}`, variant: "user", content: long ? "" : text, timestamp: "05:00 PM", ...(long ? { textAttachments: [{ id: "a", content: text, preview: text.slice(0, 40), charCount: text.length }] } : {}) });
  if (title === "New chat") title = long ? "(empty chat)" : text.slice(0, 40);
  const first = messages.find((m) => m.variant === "user");
  fs.writeFileSync(path.join(chatDir, "chat-messages.json"), JSON.stringify(messages));
  fs.writeFileSync(path.join(chatDir, "chat-meta.json"), JSON.stringify({ messageCount: messages.length, firstPrompt: first.content || "(empty chat)", messagesSize: 1, messagesMtimeMs: Date.now() }));
  answer = "";
  busyFor = 0;
  screen = "busy";
  render();
  const tick = setInterval(() => { busyFor += 250; render(); }, 250);
  setTimeout(() => {
    clearInterval(tick);
    answer = `ANSWER[${model.label}${effortOf()}] ${text.replace(/\s+/g, " ").slice(-60)}`;
    messages.push({ id: `ai-${Date.now()}`, variant: "ai", content: "", blocks: [{ type: "text", textType: "reasoning", content: "thinking" }, { type: "text", textType: "text", content: answer }], timestamp: "05:00 PM", isComplete: true, completionTime: "2s", credits: 0 });
    fs.writeFileSync(path.join(chatDir, "chat-messages.json"), JSON.stringify(messages));
    fs.writeFileSync(path.join(chatDir, "chat-meta.json"), JSON.stringify({ messageCount: messages.length, firstPrompt: first.content || "(empty chat)", messagesSize: 1, messagesMtimeMs: Date.now() }));
    screen = "idle";
    render();
  }, busyMs);
}

function key(data) {
  if (screen === "signed-out") { if (data === "\r") log("enter-on-login-screen"); return; }
  if (screen === "picker") {
    if (data === "\x1b[A") picker = Math.max(0, picker - 1);
    else if (data === "\x1b[B") picker = Math.min(MODELS.length - 1, picker + 1);
    else if (data === "\t") { const m = MODELS[picker]; if (m.efforts) { if (model.label !== m.label) model = { ...m, effort: 0 }; model.effort = (model.effort + 1) % m.efforts.length; } }
    else if (data === "\r") { const m = MODELS[picker]; if (model.label !== m.label) model = { ...m, effort: 0 }; screen = "idle"; }
    else if (data === "\x1b") screen = "idle";
    return render();
  }
  if (screen === "busy") return;
  if (data === "\r") {
    const text = pasted || typed;
    typed = ""; pasted = "";
    if (text === "/model") { picker = MODELS.findIndex((m) => m.label === model.label); screen = "picker"; return render(); }
    if (text.trim()) submit(text);
    return;
  }
  typed += data;
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk) => {
  let rest = chunk;
  while (rest.length) {
    if (inPaste) {
      const end = rest.indexOf("\x1b[201~");
      if (end < 0) { pasted += rest; return; }
      pasted += rest.slice(0, end);
      rest = rest.slice(end + 6);
      inPaste = false;
    } else if (rest.startsWith("\x1b[200~")) {
      inPaste = true;
      rest = rest.slice(6);
    } else if (rest.startsWith("\x1b[A") || rest.startsWith("\x1b[B")) {
      key(rest.slice(0, 3)); rest = rest.slice(3);
    } else {
      key(rest[0]); rest = rest.slice(1);
    }
  }
});
render();
setInterval(() => {}, 1 << 30);
