import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { PtyLifecycleManager } from "../../pty-lifecycle.js";
import { FreebuffInteractiveEngine, type FreebuffEngineDeps } from "../../freebuff-interactive.js";

export const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-freebuff.mjs");

const ENV_KEYS = ["FAKE_START_LOG", "FAKE_BUSY_MS", "FAKE_MODE", "FAKE_HOURS"] as const;

/**
 * A stand-in Freebuff on a real PTY, a home of its own, and engines to run against it:
 * what a test needs to drive the whole turn (spawn, ready, /model, paste, busy → idle,
 * read the chat). Call it inside a `describe`; it registers its own setup and teardown.
 */
export function useFakeFreebuff() {
  const state = { home: "", work: "", startLog: "", engines: [] as FreebuffInteractiveEngine[] };
  const savedHome = process.env.HOME;

  beforeEach(() => {
    state.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fb-home-")));
    state.work = path.join(state.home, "work");
    fs.mkdirSync(state.work);
    state.startLog = path.join(state.home, "starts.log");
    fs.mkdirSync(path.join(state.home, ".config", "manicode"), { recursive: true });
    fs.writeFileSync(path.join(state.home, ".config", "manicode", "credentials.json"), "{}");
    process.env.HOME = state.home;
    process.env.FAKE_START_LOG = state.startLog;
    process.env.FAKE_BUSY_MS = "500";
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_HOURS;
    state.engines = [];
  });
  afterEach(() => {
    for (const e of state.engines) e.killAll();
    process.env.HOME = savedHome;
    for (const key of ENV_KEYS) delete process.env[key];
    fs.rmSync(state.home, { recursive: true, force: true });
  });

  function engineWith(deps: FreebuffEngineDeps): FreebuffInteractiveEngine {
    const e = new FreebuffInteractiveEngine(new PtyLifecycleManager({ maxLivePtys: 8 }), deps);
    state.engines.push(e);
    return e;
  }

  return {
    state,
    engine: (maxConcurrent = 1) => engineWith({ config: () => ({ maxConcurrent }) }),
    engineWith,
    turn: (e: FreebuffInteractiveEngine, id: string, prompt: string, extra: Record<string, unknown> = {}) =>
      e.run({ sessionId: id, prompt, cwd: state.work, bin: FAKE, ...extra }),
    starts: () => (fs.existsSync(state.startLog) ? fs.readFileSync(state.startLog, "utf-8").trim().split("\n") : []),
    chatMessages: (chatId: string): Array<{ variant: string; content: string; textAttachments?: Array<{ content: string }> }> =>
      JSON.parse(fs.readFileSync(path.join(state.home, ".config", "manicode", "projects", path.basename(state.work), "chats", chatId, "chat-messages.json"), "utf-8")),
  };
}
