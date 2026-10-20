import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatFileRelPath,
  chatKey,
  extractAnswer,
  firstPromptMatches,
  localChatSource,
  pickNewChat,
  userMessageText,
  lastUserMessage,
  EMPTY_CHAT_PROMPT,
  type FreebuffChatListing,
} from "../freebuff-chat.js";

const ai = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ variant: "ai", content: "", blocks, isComplete: true, credits: 0, ...extra });
const text = (content: string) => ({ type: "text", textType: "text", content });
const reasoning = (content: string) => ({ type: "text", textType: "reasoning", content });
const tool = { type: "tool", toolName: "write_file", input: { path: "hello.txt" }, output: "ok" };

describe("extractAnswer", () => {
  it("answers with the text after the last tool call, not the thinking aloud before it", () => {
    const messages = [
      { variant: "ai", content: "", blocks: [{ type: "mode-divider", mode: "LITE" }] },
      { variant: "user", content: "make hello.txt" },
      ai([reasoning("thinking…"), tool, text("\nDONE"), reasoning("verify"), tool, text("Verified.\n\nDONE")]),
    ];
    // "DONE" came before the model checked its work; what it ends on is the answer.
    expect(extractAnswer(messages)).toEqual({ text: "Verified.\n\nDONE", credits: 0 });
  });

  it("takes every text block after the last tool call, and the last text when the reply ends on a tool call", () => {
    const user = { variant: "user", content: "q" };
    expect(extractAnswer([user, ai([tool, text("one"), reasoning("hm"), text("two")])])?.text).toBe("one\n\ntwo");
    expect(extractAnswer([user, ai([text("early"), tool, text("late"), tool])])?.text).toBe("late");
    expect(extractAnswer([user, ai([text("only"), text("these")])])?.text).toBe("only\n\nthese");
  });

  it("answers the last user message, not an earlier turn", () => {
    const messages = [
      { variant: "user", content: "one" },
      ai([text("first answer")]),
      { variant: "user", content: "two" },
    ];
    expect(extractAnswer(messages)).toBeUndefined();
    messages.push(ai([text("second answer")]));
    expect(extractAnswer(messages)?.text).toBe("second answer");
  });

  it("waits for a reply that is not complete", () => {
    const messages = [{ variant: "user", content: "q" }, ai([text("par")], { isComplete: false })];
    expect(extractAnswer(messages)).toBeUndefined();
  });

  it("falls back to the message content when it has no text blocks", () => {
    expect(extractAnswer([{ variant: "user", content: "q" }, ai([tool], { content: "  plain  " })])?.text).toBe("plain");
  });

  it("is undefined for anything that is not a message list", () => {
    expect(extractAnswer(undefined)).toBeUndefined();
    expect(extractAnswer({})).toBeUndefined();
    expect(extractAnswer([])).toBeUndefined();
  });
});

describe("firstPromptMatches", () => {
  it("ignores whitespace and accepts a recorded prompt cut short", () => {
    const sent = "Org context\n\nYou are an employee.\n\n---\nDo the thing please";
    expect(firstPromptMatches("Org context You are an employee.", sent)).toBe(true);
    expect(firstPromptMatches(sent.replace(/\n/g, "  "), sent)).toBe(true);
  });

  it("rejects another prompt and an empty one", () => {
    expect(firstPromptMatches("something else", "Do the thing")).toBe(false);
    expect(firstPromptMatches(undefined, "Do the thing")).toBe(false);
    expect(firstPromptMatches("", "Do the thing")).toBe(false);
  });
});

describe("pickNewChat", () => {
  const listing = (id: string, prompt: string | undefined, project = "work"): FreebuffChatListing => ({
    project,
    chatId: id,
    ...(prompt === undefined ? {} : { meta: { firstPrompt: prompt, messageCount: 3 } }),
  });
  const none = new Set<string>();

  it("finds the chat by what was sent when two checkouts share a basename", () => {
    // Two worktrees both named "work" write into the same projects/work/chats.
    const chats = [
      listing("2026-10-20T15-50-00.000Z", "other checkout's prompt"),
      listing("2026-10-20T15-50-31.145Z", "Create hello.txt"),
      listing("2026-10-20T15-51-02.000Z", undefined),
    ];
    const picked = pickNewChat(chats, { before: none, claimed: none, sentPrompt: "Create hello.txt" });
    expect(picked.chat).toEqual({ project: "work", chatId: "2026-10-20T15-50-31.145Z" });
    expect(picked.ambiguous).toBe(false);
  });

  it("never takes a chat that existed before the spawn or belongs to another session", () => {
    const chats = [listing("2026-10-20T15-00-00.000Z", "same words"), listing("2026-10-20T15-10-00.000Z", "same words")];
    const before = new Set([chatKey(chats[0])]);
    const claimed = new Set([chatKey(chats[1])]);
    expect(pickNewChat(chats, { before, claimed: none, sentPrompt: "same words" }).chat?.chatId).toBe("2026-10-20T15-10-00.000Z");
    expect(pickNewChat(chats, { before, claimed, sentPrompt: "same words" }).chat).toBeUndefined();
  });

  it("takes the newest of two that opened with the same words, and says so", () => {
    const chats = [listing("2026-10-20T15-10-00.000Z", "same words"), listing("2026-10-20T15-20-00.000Z", "same words")];
    const picked = pickNewChat(chats, { before: none, claimed: none, sentPrompt: "same words" });
    expect(picked.chat?.chatId).toBe("2026-10-20T15-20-00.000Z");
    expect(picked.ambiguous).toBe(true);
  });

  it("finds nothing while the new chat has no message yet", () => {
    expect(pickNewChat([listing("2026-10-20T15-10-00.000Z", undefined)], { before: none, claimed: none, sentPrompt: "x" }).chat).toBeUndefined();
  });
});

describe("localChatSource", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function configDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-chat-"));
    dirs.push(dir);
    return dir;
  }

  it("lists chats across projects, with meta only where a message exists", async () => {
    const dir = configDir();
    const write = (project: string, chatId: string, files: Record<string, unknown>) => {
      const chat = path.join(dir, "projects", project, "chats", chatId);
      fs.mkdirSync(chat, { recursive: true });
      for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(chat, name), JSON.stringify(value));
    };
    write("a", "2026-10-20T15-00-00.000Z", { "chat-meta.json": { firstPrompt: "hello", messageCount: 3 }, "chat-messages.json": [{ variant: "user" }, ai([text("hi")])] });
    write("b", "2026-10-20T15-01-00.000Z", {});
    const source = localChatSource(dir);
    const chats = await source.list();
    expect(chats.map((c) => `${c.project}/${c.chatId}:${c.meta?.firstPrompt ?? "-"}`).sort())
      .toEqual(["a/2026-10-20T15-00-00.000Z:hello", "b/2026-10-20T15-01-00.000Z:-"]);
    const messages = await source.readMessages({ project: "a", chatId: "2026-10-20T15-00-00.000Z" });
    expect(extractAnswer(messages)?.text).toBe("hi");
    expect(await source.readMessages({ project: "b", chatId: "2026-10-20T15-01-00.000Z" })).toBeUndefined();
  });

  it("lists nothing for a config dir that does not exist", async () => {
    expect(await localChatSource(path.join(os.tmpdir(), "no-such-freebuff-config")).list()).toEqual([]);
  });

  it("names a chat file relative to the config dir", () => {
    expect(chatFileRelPath({ project: "p", chatId: "c" }, "chat-messages.json")).toBe("projects/p/chats/c/chat-messages.json");
  });
});

describe("pasted messages", () => {
  const pasted = (text: string) => ({ variant: "user", content: "", textAttachments: [{ id: "a", content: text, preview: text.slice(0, 40), charCount: text.length }] });

  it("reads a message's text from its attachment when its content is empty", () => {
    expect(userMessageText(pasted("long pasted body"))).toBe("long pasted body");
    expect(userMessageText({ variant: "user", content: "typed" })).toBe("typed");
    expect(userMessageText({ variant: "user", content: "" })).toBe("");
    expect(lastUserMessage([{ variant: "user", content: "one" }, ai([text("x")]), pasted("two")])).toBe("two");
  });

  it("hands back chats that recorded no first prompt for the caller to read, newest first", () => {
    const listing: FreebuffChatListing[] = [
      { project: "work", chatId: "2026-10-20T15-00-00.000Z", meta: { firstPrompt: EMPTY_CHAT_PROMPT } },
      { project: "work", chatId: "2026-10-20T15-10-00.000Z", meta: { firstPrompt: EMPTY_CHAT_PROMPT } },
      { project: "work", chatId: "2026-10-20T15-20-00.000Z" },
    ];
    const picked = pickNewChat(listing, { before: new Set(), claimed: new Set(), sentPrompt: "a long pasted prompt" });
    expect(picked.chat).toBeUndefined();
    expect(picked.unresolved.map((c) => c.chatId)).toEqual(["2026-10-20T15-10-00.000Z", "2026-10-20T15-00-00.000Z"]);
  });
});
