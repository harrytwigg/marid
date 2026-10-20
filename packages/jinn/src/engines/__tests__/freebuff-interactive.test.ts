import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { FreebuffInteractiveEngine, buildFreebuffArgs, composeFreebuffMessage, remoteLocationNote } from "../freebuff-interactive.js";
import { detectRateLimit } from "../../shared/rateLimit.js";
import { userMessageText } from "../freebuff-chat.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-freebuff.mjs");

/**
 * The engine against a stand-in CLI on a real PTY: the stand-in draws the screens
 * the real one draws and writes its chat files where the real one does, so the
 * whole turn runs — spawn, ready, /model, paste, busy → idle, read the chat.
 */
describe.skipIf(process.platform === "win32")("FreebuffInteractiveEngine", () => {
  let home: string;
  let work: string;
  let startLog: string;
  let engines: FreebuffInteractiveEngine[];
  const savedHome = process.env.HOME;

  function engine(maxConcurrent = 1): FreebuffInteractiveEngine {
    const e = new FreebuffInteractiveEngine(new PtyLifecycleManager({ maxLivePtys: 8 }), { config: () => ({ maxConcurrent }) });
    engines.push(e);
    return e;
  }
  const turn = (e: FreebuffInteractiveEngine, id: string, prompt: string, extra: Record<string, unknown> = {}) =>
    e.run({ sessionId: id, prompt, cwd: work, bin: FAKE, ...extra });
  const starts = () => (fs.existsSync(startLog) ? fs.readFileSync(startLog, "utf-8").trim().split("\n") : []);
  const chatMessages = (chatId: string): Array<{ variant: string; content: string; textAttachments?: Array<{ content: string }> }> =>
    JSON.parse(fs.readFileSync(path.join(home, ".config", "manicode", "projects", path.basename(work), "chats", chatId, "chat-messages.json"), "utf-8"));

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fb-home-")));
    work = path.join(home, "work");
    fs.mkdirSync(work);
    startLog = path.join(home, "starts.log");
    fs.mkdirSync(path.join(home, ".config", "manicode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "manicode", "credentials.json"), "{}");
    process.env.HOME = home;
    process.env.FAKE_START_LOG = startLog;
    process.env.FAKE_BUSY_MS = "500";
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_HOURS;
    engines = [];
  });
  afterEach(() => {
    for (const e of engines) e.killAll();
    process.env.HOME = savedHome;
    delete process.env.FAKE_START_LOG;
    delete process.env.FAKE_BUSY_MS;
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_HOURS;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("answers from the chat file, puts the system prompt in front of a new chat, and resumes the same chat in the warm process", async () => {
    const e = engine();
    const first = await turn(e, "s1", "say hello", { systemPrompt: "You are Ada." });
    expect(first.error).toBeUndefined();
    expect(first.result).toContain("ANSWER[DeepSeek V4.1 Flash 10/17 • high]");
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
    expect(result.result).toContain("ANSWER[Muse Spark 1.3 • low]");
  }, 30_000);

  it("leaves the CLI's own model alone when none is configured", async () => {
    const result = await turn(engine(), "m2", "default");
    expect(result.result).toContain("ANSWER[DeepSeek V4.1 Flash 10/17 • high]");
  }, 30_000);

  it("fails a model that is not in the picker with the labels it showed, and sends nothing", async () => {
    const e = engine();
    const result = await turn(e, "m3", "never sent", { model: "Nonesuch" });
    expect(result.error).toContain('"Nonesuch"');
    expect(result.error).toContain("MiMo v2.6 Flash Slow");
    expect(result.conversationIntact).toBe(true);
    const chats = path.join(home, ".config", "manicode", "projects", path.basename(work), "chats");
    for (const chat of fs.readdirSync(chats)) expect(fs.existsSync(path.join(chats, chat, "chat-messages.json"))).toBe(false);
  }, 30_000);

  it("says Freebuff is not signed in, without starting it, when there are no credentials", async () => {
    fs.rmSync(path.join(home, ".config", "manicode", "credentials.json"));
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

  it("starts the process afresh, once, when it finds its hour session already released", async () => {
    process.env.FAKE_RELEASED_ONCE = path.join(home, "released-once");
    const result = await turn(engine(), "rel", "after the release");
    delete process.env.FAKE_RELEASED_ONCE;
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("after the release");
    expect(starts().filter((l) => l.startsWith("start "))).toHaveLength(2);
  }, 30_000);

  it("queues a second session's turn behind the first at maxConcurrent 1, taking over the idle process", async () => {
    const e = engine(1);
    const a = await turn(e, "qa", "first session");
    expect(a.error).toBeUndefined();
    expect(e.hasWarmPty("qa")).toBe(true);
    // qa's process is idle now; qb must not open a second one beside it.
    const [b1, b2] = await Promise.all([turn(e, "qb", "second session"), turn(e, "qc", "third session")]);
    expect(b1.error).toBeUndefined();
    expect(b2.error).toBeUndefined();
    expect(b1.result).toContain("second session");
    expect(b2.result).toContain("third session");
    expect(e.hasWarmPty("qa")).toBe(false);
    const alive = ["qa", "qb", "qc"].filter((id) => e.hasWarmPty(id));
    expect(alive).toHaveLength(1);
    expect(starts().filter((l) => l.startsWith("start "))).toHaveLength(3);
  }, 60_000);

  it("runs two sessions side by side when maxConcurrent is 2", async () => {
    const e = engine(2);
    const [a, b] = await Promise.all([turn(e, "pa", "alpha"), turn(e, "pb", "beta")]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(e.hasWarmPty("pa") && e.hasWarmPty("pb")).toBe(true);
  }, 60_000);

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

  it("stops a turn that is interrupted, with an Interrupted error and the chat kept", async () => {
    process.env.FAKE_BUSY_MS = "20000";
    const e = engine();
    const running = turn(e, "k1", "slow");
    await vi.waitFor(() => expect(starts().length).toBe(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 1500));
    e.kill("k1", "stop it");
    const result = await running;
    expect(result.error).toMatch(/^Interrupted/);
    expect(e.isAlive("k1")).toBe(false);
  }, 30_000);
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
