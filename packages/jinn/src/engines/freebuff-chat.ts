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

/** What `chat-meta.json` records as the first prompt of a chat whose first message was pasted: the text is in an attachment, not in the message. */
export const EMPTY_CHAT_PROMPT = "(empty chat)";

/** Fresh chats first: newest chat id first. Chat ids are ISO times, so they sort as text. */
function newestFirst<T extends { chatId: string }>(chats: readonly T[]): T[] {
  return [...chats].sort((x, y) => (x.chatId < y.chatId ? 1 : x.chatId > y.chatId ? -1 : 0));
}

/**
 * Which of the chats now on disk is the one this turn created.
 *
 * `before` is every chat that existed when the process was spawned and `claimed`
 * every chat another Marid session already owns, so only a chat born since, and
 * not spoken for, is a candidate. Among those, the one whose first prompt is the
 * message that was sent wins; the newest breaks a tie (and is logged by the
 * caller, since it means two chats opened with the same words).
 *
 * A long message is pasted, and Freebuff keeps a pasted message as an
 * attachment: its chat then records no first prompt (`(empty chat)`), so it
 * cannot be told apart by `chat-meta.json` alone. Those come back as
 * `unresolved`, newest first, for the caller to settle by reading their messages.
 */
export function pickNewChat(
  listing: readonly FreebuffChatListing[],
  opts: { before: ReadonlySet<string>; claimed: ReadonlySet<string>; sentPrompt: string },
): { chat?: FreebuffChatRef; ambiguous: boolean; unresolved: FreebuffChatListing[] } {
  const fresh = newestFirst(listing.filter((c) => !opts.before.has(chatKey(c)) && !opts.claimed.has(chatKey(c)) && c.meta));
  const matching = fresh.filter((c) => firstPromptMatches(c.meta?.firstPrompt, opts.sentPrompt));
  if (matching.length > 0) {
    return { chat: { chatId: matching[0].chatId, project: matching[0].project }, ambiguous: matching.length > 1, unresolved: [] };
  }
  const unresolved = fresh.filter((c) => !c.meta?.firstPrompt || c.meta.firstPrompt === EMPTY_CHAT_PROMPT);
  return { ambiguous: false, unresolved };
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
  textAttachments?: unknown;
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

/**
 * What a user message said. A pasted message has an empty `content`: the text is
 * in `textAttachments[].content`, which is where every long message of Marid's lands.
 */
export function userMessageText(message: unknown): string {
  const m = message as RawMessage | undefined;
  const content = typeof m?.content === "string" ? m.content : "";
  if (content.trim()) return content;
  const attachments = Array.isArray(m?.textAttachments) ? (m!.textAttachments as Array<{ content?: unknown }>) : [];
  return attachments.map((a) => (typeof a?.content === "string" ? a.content : "")).filter(Boolean).join("\n");
}

/** The text of the last user message in the chat, or undefined when there is none. */
export function lastUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as RawMessage | undefined)?.variant === "user") return userMessageText(messages[i]);
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

// ── Finding a process's chat ─────────────────────────────────────────────────

export interface LocateChatOpts {
  /** The chat this process was told to continue (its project may not be known), or the one already found. */
  known?: FreebuffChatRef;
  /** Every chat that existed before the process started. */
  before: ReadonlySet<string>;
  /** Every chat another Marid session owns. */
  claimed: ReadonlySet<string>;
  /** The message that was sent into it. */
  sent: string;
  onAmbiguous?: () => void;
}

/** How many unresolved chats are read to settle which one a pasted message went into. */
const READ_AT_MOST = 4;

async function locateByReading(source: FreebuffChatSource, candidates: readonly FreebuffChatListing[], sent: string): Promise<FreebuffChatRef | undefined> {
  for (const candidate of candidates.slice(0, READ_AT_MOST)) {
    const ref = { chatId: candidate.chatId, project: candidate.project };
    if (firstPromptMatches(lastUserMessage(await source.readMessages(ref)), sent)) return ref;
  }
  return undefined;
}

/**
 * The chat a process is in, or undefined if it cannot be told yet. A chat the
 * process was told to continue only needs its project found; a new one is the
 * one that appeared since the process started and holds what was sent.
 */
export async function locateChat(source: FreebuffChatSource, opts: LocateChatOpts): Promise<FreebuffChatRef | undefined> {
  if (opts.known?.project) return opts.known;
  const listing = await source.list();
  if (opts.known) {
    const found = listing.find((c) => c.chatId === opts.known!.chatId);
    return found ? { chatId: found.chatId, project: found.project } : undefined;
  }
  const picked = pickNewChat(listing, { before: opts.before, claimed: opts.claimed, sentPrompt: opts.sent });
  if (picked.chat && picked.ambiguous) opts.onAmbiguous?.();
  // A pasted message leaves no first prompt in the chat's meta: read the chat to see what it was sent.
  return picked.chat ?? await locateByReading(source, picked.unresolved, opts.sent);
}
