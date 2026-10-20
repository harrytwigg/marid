import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { isProcessStartFailure } from "../../shared/process-start.js";
import { localChatSource } from "../freebuff-chat.js";
import { FAKE, useFakeFreebuff } from "./helpers/freebuff-engine-harness.js";

/** Several sessions, a crash, a lagging chat file: what happens around the turn. */
describe.skipIf(process.platform === "win32")("FreebuffInteractiveEngine around the turn", () => {
  const h = useFakeFreebuff();
  const { engine, engineWith, turn, starts, chatMessages } = h;

  it("does not return the last turn's answer for the same message sent again while the chat file lags", async () => {
    process.env.FAKE_FILE_LAG_MS = "3500";
    const e = engine();
    const first = await turn(e, "again", "check children");
    expect(first.error).toBeUndefined();
    expect(first.result).toContain("ANSWER#1");
    const second = await turn(e, "again", "check children", { resumeSessionId: first.sessionId });
    delete process.env.FAKE_FILE_LAG_MS;
    expect(second.error).toBeUndefined();
    expect(second.result).toContain("ANSWER#2");
    expect(chatMessages(first.sessionId).filter((m) => m.variant === "user")).toHaveLength(2);
  }, 60_000);

  it("starts one process, not two, when the dashboard terminal and a turn start together", async () => {
    // A slow chat listing (as over ssh) keeps the start in flight long enough for the turn to arrive during it.
    const slow = localChatSource();
    const e = engineWith({
      config: () => ({ maxConcurrent: 1 }),
      localChats: () => ({ ...slow, list: async () => { await new Promise((r) => setTimeout(r, 400)); return slow.list(); } }),
    });
    e.ensureIdleSpawn("race", { cwd: h.state.work, bin: FAKE, cols: 120, rows: 40 });
    const result = await turn(e, "race", "hi");
    expect(result.error).toBeUndefined();
    expect(starts().filter((l) => l.startsWith("start "))).toHaveLength(1);
    expect(e.hasWarmPty("race")).toBe(true);
  }, 30_000);

  it("reports a process that dies mid-answer as an interruption that names its chat, never as a failed start", async () => {
    process.env.FAKE_BUSY_MS = "20000";
    const e = engine();
    const running = turn(e, "crash", "slow work");
    await vi.waitFor(() => expect(starts().length).toBe(1), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 2500));
    process.kill(Number(/pid=(\d+)/.exec(starts()[0])![1]), "SIGKILL");
    const result = await running;
    // The runner sends a message again after a failed start: a crash mid-answer must not look like one.
    expect(isProcessStartFailure(result.error ?? "")).toBe(false);
    expect(result.error).toMatch(/^Interrupted/);
    expect(result.conversationIntact).toBe(true);
    expect(result.sessionId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(chatMessages(result.sessionId).filter((m) => m.variant === "user")).toHaveLength(1);
  }, 40_000);

  it("never has a terminal and a turn's process alive at once at maxConcurrent 1, whichever started first", async () => {
    // A slow chat listing keeps the terminal's start in flight while the turn takes over its slot.
    const slow = localChatSource();
    const e = engineWith({
      config: () => ({ maxConcurrent: 1 }),
      localChats: () => ({ ...slow, list: async () => { await new Promise((r) => setTimeout(r, 400)); return slow.list(); } }),
    });
    e.ensureIdleSpawn("termA", { cwd: h.state.work, bin: FAKE, cols: 120, rows: 40 });
    const result = await turn(e, "turnB", "hi");
    expect(result.error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1500));
    expect(e.hasWarmPty("termA")).toBe(false);
    expect(e.hasWarmPty("turnB")).toBe(true);
    expect(starts().filter((l) => l.startsWith("start "))).toHaveLength(1);
  }, 40_000);

  it("keeps its slot while it starts the process over, so a turn queued behind it does not jump ahead", async () => {
    process.env.FAKE_RELEASED_ON_SUBMIT = path.join(h.state.home, "released-on-submit");
    const e = engine(1);
    const finished: string[] = [];
    const first = turn(e, "slotX", "first in line").then((r) => { finished.push("X"); return r; });
    await vi.waitFor(() => expect(starts().length).toBeGreaterThan(0), { timeout: 10_000 });
    const second = turn(e, "slotY", "queued behind").then((r) => { finished.push("Y"); return r; });
    const [x, y] = await Promise.all([first, second]);
    delete process.env.FAKE_RELEASED_ON_SUBMIT;
    expect(x.error).toBeUndefined();
    expect(y.error).toBeUndefined();
    expect(finished).toEqual(["X", "Y"]);
  }, 90_000);

  it("reads the chat file once the file changes, not on every poll while it lags", async () => {
    process.env.FAKE_FILE_LAG_MS = "3500";
    let reads = 0;
    const source = localChatSource();
    const e = engineWith({
      config: () => ({ maxConcurrent: 1 }),
      localChats: () => ({ ...source, readMessages: async (chat) => { reads += 1; return source.readMessages(chat); } }),
    });
    const first = await turn(e, "stat", "one");
    const afterFirst = reads;
    const second = await turn(e, "stat", "two", { resumeSessionId: first.sessionId });
    delete process.env.FAKE_FILE_LAG_MS;
    expect(second.result).toContain("ANSWER#2");
    // The file did not change for 3.5s after the screen said done: no read until it did.
    expect(reads - afterFirst).toBeLessThanOrEqual(2);
  }, 60_000);

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
