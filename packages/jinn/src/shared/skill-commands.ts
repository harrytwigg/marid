import fs from "node:fs";
import { SKILLS_DIR } from "./paths.js";

/** Names of installed jinn skills (directories under ~/.jinn/skills).
 *  Read fresh per call — one cheap readdir, never a hot path. Skills are added
 *  and removed while the gateway runs, so a cached set would answer for a
 *  workspace that no longer exists. */
export function installedSkillNames(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

/** Decide how a user message must be fed into an engine's TUI.
 *
 *  A leading `@` (mention) or `!` (bash-mode) always gets a space prepended so
 *  the TUI treats it as literal text instead of swallowing the turn.
 *
 *  A leading `/` is space-prepended ONLY when its first token names an installed
 *  jinn skill (so the model reads it and invokes the skill). Any other
 *  `/command` is passed through raw, letting engine-native commands like
 *  `/compact`, `/clear`, `/model` actually fire. */
export function neutralizeForPaste(text: string): string {
  if (/^[@!]/.test(text)) return " " + text;
  if (text.startsWith("/")) {
    const cmd = text.slice(1).split(/\s/, 1)[0];
    return installedSkillNames().has(cmd) ? " " + text : text;
  }
  return text;
}

/** Claude Code built-in slash commands that run locally and never produce a new
 *  assistant API turn. Two behaviours, both handled by the native-command path:
 *   - Context mutators (/compact, /clear, /model) end without firing a Stop hook;
 *     the native-command quiet-window timer settles them with an empty result.
 *   - Info/overlay commands (/usage, /limits, /cost, …) DO fire a Stop hook on
 *     dismiss, but its `last_assistant_message` still carries the PREVIOUS turn's
 *     text. Without native classification that stale text was persisted as a new
 *     assistant message — the duplicate-chat-echo bug. native-aware maybeComplete
 *     settles these empty instead.
 *  Only commands that genuinely yield no persistable assistant output belong here:
 *  misclassifying a real-turn command (/init, /review, skill commands) would drop
 *  its answer. */
const NATIVE_CLAUDE_COMMANDS = new Set([
  "/compact", "/clear", "/model",
  "/usage", "/limits", "/cost", "/status", "/config", "/help", "/doctor",
  "/release-notes", "/vim", "/terminal-setup", "/mcp", "/agents", "/permissions",
  "/hooks", "/memory", "/export", "/login", "/logout", "/bug", "/resume",
]);

export function isNativeClaudeCommand(prompt: string): boolean {
  const first = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return first !== undefined && NATIVE_CLAUDE_COMMANDS.has(first);
}

/** A turn asking for the engine's own compaction (Claude Code's `/compact`,
 *  opencode's summarize). The rest of the line is Claude Code's summary
 *  instructions; opencode takes none. */
export function isCompactCommand(prompt: string): boolean {
  return /^\/compact(?:\s|$)/.test(prompt.trimStart());
}

/**
 * Whether this turn's prompt is an engine-native command that has to reach the
 * engine exactly as written. Anything put in front of it — a platform-context
 * refresh, the system prompt — turns the command into text for the model, and
 * the command never runs.
 */
export function isRawEngineCommand(engine: string, prompt: string): boolean {
  return isCompactCommand(prompt) || (engine === "claude" && isNativeClaudeCommand(prompt));
}
