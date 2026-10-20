import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { buildFreebuffArgs, composeFreebuffMessage, remoteLocationNote } from "../freebuff-interactive.js";
import { detectRateLimit } from "../../shared/rateLimit.js";
import { userMessageText } from "../freebuff-chat.js";
import { useFakeFreebuff } from "./helpers/freebuff-engine-harness.js";

/**
 * The engine against a stand-in CLI on a real PTY: the stand-in draws the screens
 * the real one draws and writes its chat files where the real one does, so the
 * whole turn runs.
 */
describe.skipIf(process.platform === "win32")("FreebuffInteractiveEngine", () => {
  const h = useFakeFreebuff();
  const { engine, engineWith, turn, starts, chatMessages } = h;

  it("answers from the chat file, puts the system prompt in front of a new chat, and resumes the same chat in the warm process", async () => {
    const e = engine();
    const first = await turn(e, "s1", "say hello", { systemPrompt: "You are Ada." });
    expect(first.error).toBeUndefined();
    expect(first.result).toContain("ANSWER#1[DeepSeek V4.1 Flash 10/17 • high]");
    expect(first.result).toContain("say hello");
    expect(first.sessionId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    expect(first.numTurns).toBe(1);
    expect(first.cost).toBe(0);
    expect(first.contextTokens).toBe(13_500);
    expect(userMessageText(chatMessages(first.sessionId).find((m) => m.variant === "user"))).toContain("You are Ada.");

    const second = await turn(e, "s1", "and again", { resumeSessionId: first.sessionId });
    expect(second.error).toBeUndefined();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.result).toContain("and again");
    const users = chatMessages(first.sessionId).filter((m) => m.variant === "user");
    expect(users).toHaveLength(2);
    // The second turn reused the process: one start, and no system prompt again.
    expect(starts()).toHaveLength(1);
    expect(userMessageText(users[1])).not.toContain("You are Ada.");
  }, 30_000);

  it("takes a multi-line message of 30 KB as one message and still finds its chat", async () => {
    const body = Array.from({ length: 450 }, (_, i) => `LINE ${String(i + 1).padStart(4, "0")} the quick brown fox jumps over the lazy dog 0123456789`).join("\n");
    expect(body.length).toBeGreaterThan(28_000);
    const result = await turn(engine(), "big", body, { systemPrompt: "ctx" });
    expect(result.error).toBeUndefined();
    expect(result.sessionId).not.toBe("");
    const users = chatMessages(result.sessionId).filter((m) => m.variant === "user");
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe("");
    expect(users[0].textAttachments?.[0].content).toContain("LINE 0450");
    expect(users[0].textAttachments?.[0].content.split("\n").length).toBeGreaterThan(450);
  }, 30_000);

  it("drives /model to the configured model and level before the message, and says so in the answer", async () => {
    const result = await turn(engine(), "m1", "pick", { model: "Muse Spark", effortLevel: "low" });
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("ANSWER#1[Muse Spark 1.3 • low]");
  }, 30_000);

  it("leaves the CLI's own model alone when none is configured", async () => {
    const result = await turn(engine(), "m2", "default");
    expect(result.result).toContain("ANSWER#1[DeepSeek V4.1 Flash 10/17 • high]");
  }, 30_000);

  it("sets a Claude alias aside, as an employee file's default `sonnet` is, and leaves the CLI's choice alone", async () => {
    const result = await turn(engine(), "alias", "default model please", { model: "sonnet" });
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("ANSWER#1[DeepSeek V4.1 Flash 10/17 • high]");
  }, 30_000);

  it("uses engines.freebuff.model in place of such an alias", async () => {
    const e = engineWith({ config: () => ({ maxConcurrent: 1, model: "Muse Spark" }) });
    const result = await turn(e, "alias2", "configured model please", { model: "sonnet" });
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("ANSWER#1[Muse Spark 1.3 • high]");
  }, 30_000);

  it("fails a model that is not in the picker with the labels it showed, and sends nothing", async () => {
    const e = engine();
    const result = await turn(e, "m3", "never sent", { model: "Nonesuch" });
    expect(result.error).toContain('"Nonesuch"');
    expect(result.error).toContain("MiMo v2.6 Flash Slow");
    expect(result.conversationIntact).toBe(true);
    const chats = path.join(h.state.home, ".config", "manicode", "projects", path.basename(h.state.work), "chats");
    for (const chat of fs.readdirSync(chats)) expect(fs.existsSync(path.join(chats, chat, "chat-messages.json"))).toBe(false);
  }, 30_000);

  it("says Freebuff is not signed in, without starting it, when there are no credentials", async () => {
    fs.rmSync(path.join(h.state.home, ".config", "manicode", "credentials.json"));
    const result = await turn(engine(), "so", "hi");
    expect(result.error).toBe('freebuff is not signed in on local; run "freebuff login" there');
    expect(starts()).toEqual([]);
  });

  it("recognises the sign-in screen after the first message and never presses Enter on it", async () => {
    process.env.FAKE_MODE = "signed-out";
    const result = await turn(engine(), "so2", "hi");
    expect(result.error).toBe('freebuff is not signed in on local; run "freebuff login" there');
    expect(starts().filter((l) => l.startsWith("enter-on-login-screen"))).toEqual([]);
  }, 30_000);

  it("maps no hours left to a rate limit, so a fallback engine takes the turn", async () => {
    process.env.FAKE_HOURS = "0";
    const result = await turn(engine(), "h0", "hi");
    expect(result.error).toContain("no hours left today");
    expect(result.rateLimit).toEqual({ status: "rejected", rateLimitType: "hours" });
    expect(detectRateLimit(result).limited).toBe(true);
  }, 30_000);

  it("starts the process afresh when the session is released as the message goes in, and the message runs once", async () => {
    process.env.FAKE_RELEASED_ON_SUBMIT = path.join(h.state.home, "released-on-submit");
    const result = await turn(engine(), "rel2", "after the release");
    delete process.env.FAKE_RELEASED_ON_SUBMIT;
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("after the release");
    expect(starts().filter((l) => l.startsWith("start "))).toHaveLength(2);
    expect(chatMessages(result.sessionId).filter((m) => m.variant === "user")).toHaveLength(1);
  }, 40_000);

  it("completes a turn whose message and answer quote the refusals, rather than failing or restarting on them", async () => {
    const prompt = "Session limit reached. is what the CLI prints when the day is used up; Not enough hours: 0.4 available. is the other, and This session was released. a third. Just say ok.";
    const result = await turn(engine(), "quote", prompt);
    expect(result.error).toBeUndefined();
    expect(result.rateLimit).toBeUndefined();
    expect(result.result).toMatch(/ANSWER#\d+\[/);
    expect(starts().filter((l) => l.startsWith("start "))).toHaveLength(1);
  }, 30_000);

  it("fails a turn the model ended without saying anything, rather than returning an empty answer", async () => {
    process.env.FAKE_EMPTY_ANSWER = "1";
    const result = await turn(engine(), "empty", "say nothing");
    delete process.env.FAKE_EMPTY_ANSWER;
    expect(result.error).toContain("ended the turn without an answer");
    expect(result.conversationIntact).toBe(true);
  }, 30_000);

  it("resumes a chat in a new process with --continue when no process is warm", async () => {
    const e = engine();
    const first = await turn(e, "r1", "remember seven");
    e.kill("r1");
    const again = await turn(e, "r1", "what number", { resumeSessionId: first.sessionId });
    expect(again.error).toBeUndefined();
    expect(again.sessionId).toBe(first.sessionId);
    expect(starts().filter((l) => l.includes(`continue=${first.sessionId}`))).toHaveLength(1);
    expect(chatMessages(first.sessionId).filter((m) => m.variant === "user")).toHaveLength(2);
  }, 60_000);
});

describe("composeFreebuffMessage", () => {
  it("puts a new chat's system prompt in front of the first message", () => {
    expect(composeFreebuffMessage({ prompt: "do it", systemPrompt: "You are Ada." })).toBe("You are Ada.\n\n---\n\ndo it");
  });

  it("does not repeat the system prompt on a resumed chat, but carries a platform refresh", () => {
    expect(composeFreebuffMessage({ prompt: "next", systemPrompt: "You are Ada.", resumeSessionId: "c" })).toBe("next");
    expect(composeFreebuffMessage({ prompt: "next", resumeSessionId: "c", platformContextRefresh: "It is Tuesday." })).toBe("It is Tuesday.\n\n---\n\nnext");
  });

  it("tells a remote chat where it really runs, after the context that names the gateway's home", () => {
    const message = composeFreebuffMessage({ prompt: "do it", systemPrompt: "Your working directory is ~/.jinn." }, "/work/area");
    expect(message).toBe(`Your working directory is ~/.jinn.\n\n${remoteLocationNote("/work/area")}\n\n---\n\ndo it`);
    expect(remoteLocationNote("/work/area")).toContain("`/work/area`");
    // Nothing to correct when there is no context, or when the chat already has it.
    expect(composeFreebuffMessage({ prompt: "do it" }, "/work/area")).toBe("do it");
    expect(composeFreebuffMessage({ prompt: "next", resumeSessionId: "c" }, "/work/area")).toBe("next");
  });

  it("lists attachments after the message", () => {
    expect(composeFreebuffMessage({ prompt: "look", attachments: ["/a/b.png"] })).toBe("look\n\nAttached files:\n- /a/b.png");
  });
});

describe("buildFreebuffArgs", () => {
  it("always trusts the folder, and continues a chat only when given one", () => {
    expect(buildFreebuffArgs({ cwd: "/w" })).toEqual(["--cwd", "/w", "--trust-agents"]);
    expect(buildFreebuffArgs({ cwd: "/w", chatId: "2026-10-20T15-50-31.145Z" })).toEqual(["--cwd", "/w", "--trust-agents", "--continue", "2026-10-20T15-50-31.145Z"]);
  });
});
