import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Freebuff keeps each conversation on disk, and that file — not the screen — is
 * where a turn's answer is read from: the screen wraps and truncates, the file
 * holds the model's text verbatim.
 *
 *   <config>/projects/<basename of the project root>/chats/<chatId>/
 *     chat-meta.json      { messageCount, firstPrompt, messagesSize, messagesMtimeMs }
 *     chat-messages.json  [{ id, variant: "user" | "ai", content, blocks, isComplete, … }]
 *
 * `chatId` is an ISO time with `:` replaced by `-`. Two projects can share a
 * basename (worktrees do), so the newest directory is never taken on trust: a
 * chat is found by what was sent into it.
 */

export interface FreebuffChatMeta {
  messageCount?: number;
  firstPrompt?: string;
  messagesSize?: number;
  messagesMtimeMs?: number;
}

export interface FreebuffChatRef {
  /** The directory name under `chats/`, and what `--continue` takes. */
  chatId: string;
  /** The `projects/` entry it was found under. */
  project: string;
}

export interface FreebuffChatListing extends FreebuffChatRef {
  /** Absent for a chat that has no message yet: its directory holds a log only. */
  meta?: FreebuffChatMeta;
}

export function chatKey(ref: FreebuffChatRef): string {
  return `${ref.project}/${ref.chatId}`;
}

/** Freebuff's config dir under `home`. */
export function freebuffConfigDir(home: string = os.homedir()): string {
  return path.join(home, ".config", "manicode");
}

/** Where a chat's files are, as a POSIX-style path relative to the config dir. */
export function chatFileRelPath(ref: FreebuffChatRef, file: "chat-messages.json" | "chat-meta.json"): string {
  return path.posix.join("projects", ref.project, "chats", ref.chatId, file);
}

const NORMALIZE_WIDTH = 200;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a chat's recorded first prompt is the message that was sent.
 *
 * The recorded prompt may be cut short, and a bracketed paste can come back
 * with its line breaks changed, so both sides are whitespace-normalised and
 * compared by their opening characters.
 */
export function firstPromptMatches(recorded: string | undefined, sent: string): boolean {
  if (!recorded) return false;
  const a = normalize(recorded);
  const b = normalize(sent);
  if (!a || !b) return false;
  return b.startsWith(a) || a.startsWith(b.slice(0, Math.min(b.length, NORMALIZE_WIDTH)));
}

/**
 * Which of the chats now on disk is the one this turn created.
 *
 * `before` is every chat that existed when the process was spawned and `claimed`
 * every chat another Marid session already owns, so only a chat born since, and
 * not spoken for, is a candidate. Among those, the one whose first prompt is the
 * message that was sent wins; the newest breaks a tie (and is logged by the
 * caller, since it means two chats opened with the same words).
 */
export function pickNewChat(
  listing: readonly FreebuffChatListing[],
  opts: { before: ReadonlySet<string>; claimed: ReadonlySet<string>; sentPrompt: string },
): { chat?: FreebuffChatRef; ambiguous: boolean } {
  const fresh = listing.filter((c) => !opts.before.has(chatKey(c)) && !opts.claimed.has(chatKey(c)));
  const matching = fresh.filter((c) => firstPromptMatches(c.meta?.firstPrompt, opts.sentPrompt));
  if (matching.length === 0) return { ambiguous: false };
  const newest = [...matching].sort((x, y) => (x.chatId < y.chatId ? 1 : x.chatId > y.chatId ? -1 : 0))[0];
  return { chat: { chatId: newest.chatId, project: newest.project }, ambiguous: matching.length > 1 };
}

export interface FreebuffAnswer {
  text: string;
  credits?: number;
}

interface RawBlock {
  type?: unknown;
  textType?: unknown;
  content?: unknown;
}

interface RawMessage {
  variant?: unknown;
  content?: unknown;
  blocks?: unknown;
  isComplete?: unknown;
  credits?: unknown;
}

/** The answer text of one AI message: its `text` blocks, not its reasoning or tool calls. */
function messageText(message: RawMessage): string {
  const blocks = Array.isArray(message.blocks) ? (message.blocks as RawBlock[]) : [];
  const parts = blocks
    .filter((b) => b.type === "text" && b.textType !== "reasoning" && typeof b.content === "string")
    .map((b) => (b.content as string).trim())
    .filter(Boolean);
  if (parts.length) return parts.join("\n\n");
  return typeof message.content === "string" ? message.content.trim() : "";
}

/**
 * The reply to the last user message: the last completed AI message after it.
 * `undefined` while the model is still answering (no completed message yet), so
 * the caller can wait for the file rather than return half an answer.
 */
export function extractAnswer(messages: unknown): FreebuffAnswer | undefined {
  if (!Array.isArray(messages)) return undefined;
  const list = messages as RawMessage[];
  let lastUser = -1;
  list.forEach((m, i) => { if (m?.variant === "user") lastUser = i; });
  for (let i = list.length - 1; i > lastUser; i--) {
    const m = list[i];
    if (m?.variant !== "ai" || m.isComplete !== true) continue;
    const text = messageText(m);
    return { text, ...(typeof m.credits === "number" ? { credits: m.credits } : {}) };
  }
  return undefined;
}

/** How many user messages the chat holds: the turn counter a caller compares across turns. */
export function countUserMessages(messages: unknown): number {
  return Array.isArray(messages) ? (messages as RawMessage[]).filter((m) => m?.variant === "user").length : 0;
}

// ── Reading chats ────────────────────────────────────────────────────────────

/** Where chats are read from: this machine, or the host a remote employee runs on. */
export interface FreebuffChatSource {
  /** Every chat that has a directory, with its meta when it has one. */
  list(): Promise<FreebuffChatListing[]>;
  /** The chat's messages, or undefined when the file is not there (yet). */
  readMessages(chat: FreebuffChatRef): Promise<unknown | undefined>;
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

export function localChatSource(configDir: string = freebuffConfigDir()): FreebuffChatSource {
  const projects = path.join(configDir, "projects");
  const subdirs = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  return {
    async list() {
      const out: FreebuffChatListing[] = [];
      for (const project of subdirs(projects)) {
        for (const chatId of subdirs(path.join(projects, project, "chats"))) {
          const meta = readJson(path.join(projects, project, "chats", chatId, "chat-meta.json"));
          out.push({ project, chatId, ...(meta && typeof meta === "object" ? { meta: meta as FreebuffChatMeta } : {}) });
        }
      }
      return out;
    },
    async readMessages(chat) {
      return readJson(path.join(configDir, chatFileRelPath(chat, "chat-messages.json")));
    },
  };
}
