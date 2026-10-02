import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * JIN-3: a message sent from the composer while the CLI view is open was
 * persisted to chat but never reached Claude Code. The warm-PTY paste landed in
 * a TUI state that swallows it — the Esc Esc rewind menu takes the CR as
 * "continue" and the text vanishes; the ctrl+o transcript view and a ctrl+z
 * suspend eat it too (verified on claude 2.1.283). The submit confirmation saw
 * no UserPromptSubmit, logged "text may be stranded", and left the turn to the
 * 15-minute stall backstop. Now the engine respawns the session with the prompt
 * in argv, the path a cold turn takes.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  writes: string[];
  kills: number;
  dataCbs: Array<(d: string) => void>;
  emit: (d: string) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  fireExit: () => void;
}

const ptys: FakePty[] = [];
const spawnArgs: string[][] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 3000 + ptys.length,
    _exitCode: null,
    writes: [],
    kills: 0,
    dataCbs: [],
    emit(d) { for (const cb of p.dataCbs) cb(d); },
    onData(cb) { p.dataCbs.push(cb); },
    onExit(cb) { p._exitCb = cb; },
    kill() { p.kills += 1; },
    write(d: string) { p.writes.push(d); },
    resize() {},
    on() {},
    fireExit() { p._exitCode = 0; p._exitCb?.({ exitCode: 0 }); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => { const p = makeFakePty(); ptys.push(p); spawnArgs.push(args); return p; }),
}));
/** Holds the per-PTY proxy start open, so a test can stop the turn mid-respawn. */
let proxyGate: Promise<void> | undefined;
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { if (proxyGate) await proxyGate; return 41100; }
    stop() {}
  },
}));
/** Hold-open gates for the two remote calls that take seconds on a real host. */
const remote = vi.hoisted(() => ({
  readyGate: undefined as Promise<void> | undefined,
  stageGate: undefined as Promise<void> | undefined,
  stagings: 0,
}));
vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async () => {
      if (remote.readyGate) await remote.readyGate;
      return {
        ready: true,
        facts: { home: "/home/b", stageDir: "/stage", nodeBin: "/usr/bin/node", claudeBin: "/usr/local/bin/claude", jinnVersion: "0.33.3", entryDir: "/usr/lib/jinn/src/mcp" },
      };
    }),
    // Staging is what rewrites the session's gateway.json on the host.
    prepareRemoteSession: vi.fn(async () => {
      remote.stagings += 1;
      if (remote.stageGate) await remote.stageGate;
      return { destination: "b@box", tunnelPort: 44321, sessionHome: "/stage/sessions/x", settingsPath: "/stage/sessions/x/tmp/settings.json", envFilePath: "/stage/sessions/x/tmp/env.sh" };
    }),
  };
});
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
  cleanupSessionSettings: () => {},
}));

import { InteractiveClaudeEngine, transcriptHasPromptSince, viewportShowsRewindMenu } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/** Long enough for the initial CR plus every re-sent one to go unanswered. */
const PAST_SUBMIT_RETRIES_MS = 25_000;
const lastArg = (args: string[]) => args[args.length - 1];

/** Claude Code 2.1.283's Esc Esc Rewind menu, verbatim from the JIN-3 probe
 *  capture (jin3-evidence/probes/out-escesc.txt, [escesc] screen before paste).
 * detects this shape before pasting into a warm PTY. */
const REWIND_MENU_FRAME = [
  "   Rewind",
  "   Restore the code and/or conversation to the point before…",
  "     Reply with exactly the word READY.",
  "     No code changes",
  "   ❯ (current)",
  "   Enter to continue · Esc to cancel",
].join("\r\n");

/** The Rewind flow on claude 2.1.284, verbatim from the senior-QA captures
 *  (f140.json at 140 columns, f50.json at 50, f30.json at 30). `list` is stage
 * 1; `moved` is stage 1 with the arrow on a rewind point (the trigger);
 *  `confirm` is the stage-2 restore dialog Enter opens, whose default highlight
 *  is destructive. f50 and f30 are the wrapped shapes: f50 is what the first
 *  detector missed, f30 is the floor — there the description, the stage-2 label
 *  and the footer all wrap, and the details are verifiable because it is the
 *  narrowest caption captured for both stages. The blank rows are the capture's
 *  own viewport padding. */
const REWIND_284 = {
  f140: {
    list: ["   Rewind", "", "   Restore the code and/or conversation to the point before…", "", "     Reply with exactly the word READY.", "     No code changes", "", "   ❯ (current)", "", "", "", "   Enter to continue · Esc to cancel"],
    moved: ["   Rewind", "", "   Restore the code and/or conversation to the point before…", "", "   ❯ Reply with exactly the word READY.", "     No code changes", "", "     (current)", "", "", "", "   Enter to continue · Esc to cancel"],
    confirm: ["   Rewind", "", "   Confirm you want to restore to the point before you sent this message:", "", "   │ Reply with exactly the word READY.", "   │ (6s ago)", "", "   The conversation will be forked.", "   The code will be unchanged.", "    ", "   ❯ 1. Restore conversation", "     2. Summarize from here", "     3. Summarize up to here", "     4. Never mind"],
  },
  f50: {
    list: ["   Rewind", "", "   Restore the code and/or conversation to the", "   point before…", "", "     Reply with exactly the word READY.", "     No code changes", "", "   ❯ (current)", "", "", "", "   Enter to continue · Esc to cancel"],
    moved: ["   Rewind", "", "   Restore the code and/or conversation to the", "   point before…", "", "   ❯ Reply with exactly the word READY.", "     No code changes", "", "     (current)", "", "", "", "   Enter to continue · Esc to cancel"],
    confirm: ["   Rewind", "", "   Confirm you want to restore to the point", "   before you sent this message:", "", "   │ Reply with exactly the word READY.", "   │ (8s ago)", "", "   The conversation will be forked.", "   The code will be unchanged.", "     ", "   ❯ 1. Restore conversation", "     2. Summarize from here", "     3. Summarize up to here", "     4. Never mind"],
  },
  f30: {
    list: ["   Rewind", "", "   Restore the code and/or", "   conversation to the", "   point before…", "", "     Reply with exactly …", "     No code changes", "", "   ❯ (current)", "", "", "", "   Enter to continue · Esc ", "   to cancel"],
    moved: ["   Rewind", "", "   Restore the code and/or", "   conversation to the", "   point before…", "", "   ❯ Reply with exactly …", "     No code changes", "", "     (current)", "", "", "", "   Enter to continue · Esc ", "   to cancel"],
    confirm: ["   Rewind", "", "   Confirm you want to", "   restore to the point", "   before you sent this", "   message:", "", "   │ Reply with exactly the", "   │ word READY.", "   │ (6s ago)", "", "   The conversation will be", "   forked.", "   The code will be ", "   unchanged.", "", "   ❯ 1. Restore conversation", "     2. Summarize from here", "     3. Summarize up to here", "     4. Never mind"],
  },
};

/** The stage-2 dialog at 140 columns, joined for the engine tests, which emit
 *  raw bytes into the PTY rather than passing a viewport array. */
const REWIND_CONFIRM_FRAME = REWIND_284.f140.confirm.join("\r\n");

describe("InteractiveClaudeEngine — a paste the TUI never took (JIN-3)", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    spawnArgs.length = 0;
    proxyGate = undefined;
    remote.readyGate = undefined;
    remote.stageGate = undefined;
    remote.stagings = 0;
    hookCb = undefined;
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      // As the gateway's registry: a released PTY takes the registration with it.
      unregister: () => { hookCb = undefined; },
    } as any;
    // As the gateway wires it: releasing a PTY unregisters the session's hooks.
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10, onCleanup: (id) => hookRegistry.unregister(id) });
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry, {
      remote: () => ({ root: "/srv/jinn-work", mount: "/mnt/jinn-home" }),
      gatewayPort: () => 7777,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const REMOTE = { remoteHost: "box", remoteUser: "b", remoteCwd: "/srv/jinn-work/proj" };

  async function warmSession(sessionId: string, target: object = {}): Promise<FakePty> {
    const turn = engine.run({ sessionId, prompt: "first", cwd: "/tmp", resumeSessionId: "c1", ...target } as any);
    await vi.advanceTimersByTimeAsync(20);
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    expect((await turn).error).toBeUndefined();
    expect(engine.hasWarmPty(sessionId)).toBe(true);
    return ptys[0];
  }

  it("respawns with the prompt in argv and settles on the new PTY's own turn", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-swallowed");

    const turn = engine.run({ sessionId: "s-swallowed", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);

    // The warm PTY was released and a fresh one spawned, resuming the same
    // conversation with the undelivered prompt as its argv prompt.
    expect(warm.kills).toBeGreaterThan(0);
    expect(ptys).toHaveLength(2);
    expect(spawnArgs[1]).toEqual(expect.arrayContaining(["--resume", "c1"]));
    expect(lastArg(spawnArgs[1])).toContain("second");
    expect(engine.turnProgress("s-swallowed")?.awaitingSubmit).toBe(false);

    // The old PTY dying now is a benign respawn, not this turn's crash.
    warm.fireExit();

    // The turn re-registered its hooks (the release dropped them) and takes
    // the new PTY's turn as its own.
    expect(hookCb).toBeDefined();
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "second done" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("second done");
    expect(engine.hasWarmPty("s-swallowed")).toBe(true);
  });

  it("a respawned process that dies before its session starts fails the turn with what it printed", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-respawn-dies");
    const turn = engine.run({ sessionId: "s-respawn-dies", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
    expect(ptys).toHaveLength(2);
    warm.fireExit();

    // The first process's SessionStart says nothing about this one: it dies on boot.
    const respawned = ptys[1];
    respawned.emit("error: unknown option '--bogus'\r\n");
    respawned._exitCode = 1;
    respawned._exitCb?.({ exitCode: 1 });
    const r = await turn;
    expect(r.error).toBe("claude did not start: its process exited (code 1, signal unknown) before its session began. Its last output: error: unknown option '--bogus'");
  });

  it("a live Rewind menu is not pasted into — the turn respawns at once, emitting no CR", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-rewind");
    warm.emit(REWIND_MENU_FRAME);
    const before = warm.writes.length;

    const turn = engine.run({ sessionId: "s-rewind", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    // Well inside the submit-confirm window (the first CR fires at 150ms): had
    // the paste happened it would already be on the wire, and its CR would be
    // about to confirm the highlighted rewind instead of the message.
    await vi.advanceTimersByTimeAsync(100);

    expect(warm.writes.slice(before)).toEqual([]); // no paste, no CR, no retries
    expect(ptys).toHaveLength(2); // delivered by respawn, not by retrying
    expect(spawnArgs[1]).toEqual(expect.arrayContaining(["--resume", "c1"]));
    expect(lastArg(spawnArgs[1])).toContain("second");

    // The respawned argv turn is still this turn's own.
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "second done" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("second done");
  });

  it("with no Rewind menu the composer message is pasted exactly as before", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-no-rewind");
    const before = warm.writes.length;

    const turn = engine.run({ sessionId: "s-no-rewind", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);

    // The bracketed paste went to the warm PTY and no respawn happened.
    const written = warm.writes.slice(before);
    expect(written.some((w) => w.includes("\x1b[200~") && w.includes("second"))).toBe(true);
    expect(ptys).toHaveLength(1);

    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "ok" });
    expect((await turn).result).toBe("ok");
  });

  it("a menu that opens between retries suppresses the CR and respawns", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-mid-rewind");
    const turn = engine.run({ sessionId: "s-mid-rewind", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200); // the initial CR, still unacknowledged
    expect(warm.writes.filter((w) => w === "\r")).toHaveLength(1);
    const afterInitial = warm.writes.length;

    // The menu opens now, after the paste: the retry CR due next would confirm
    // the highlighted rewind rather than submit the message.
    warm.emit(REWIND_MENU_FRAME);
    await vi.advanceTimersByTimeAsync(2_000); // past the first retry tick

    expect(warm.writes.slice(afterInitial)).toEqual([]); // the retry CR was not written
    expect(ptys).toHaveLength(2); // the turn took the respawn path instead
    expect(lastArg(spawnArgs[1])).toContain("second");

    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "second done" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("second done");
  });

  it("a menu that opens between the paste and the first CR suppresses that CR", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-beat-rewind");
    const turn = engine.run({ sessionId: "s-beat-rewind", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);

    // Past the paste, before the 150ms submit beat. The stage-2 dialog opens in
    // that gap: its default highlight is the destructive "Restore conversation".
    await vi.advanceTimersByTimeAsync(20);
    expect(warm.writes.some((w) => w.includes("second"))).toBe(true);
    warm.emit(REWIND_CONFIRM_FRAME);

    await vi.advanceTimersByTimeAsync(200);
    expect(warm.writes.filter((w) => w === "\r")).toHaveLength(0); // the first CR was not written
    expect(ptys).toHaveLength(2); // respawned instead
    expect(lastArg(spawnArgs[1])).toContain("second");

    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "second done" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("second done");
  });

  it("a native command's single CR is gated too", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-native-cr");
    const turn = engine.run({ sessionId: "s-native-cr", prompt: "/compact", cwd: "/tmp", resumeSessionId: "c1" } as any);

    await vi.advanceTimersByTimeAsync(20); // the paste is down, the CR is not due yet
    warm.emit(REWIND_MENU_FRAME);
    await vi.advanceTimersByTimeAsync(200);

    expect(warm.writes.filter((w) => w === "\r")).toHaveLength(0);
    expect(ptys).toHaveLength(2); // respawned rather than confirming the rewind

    engine.kill("s-native-cr", "Interrupted: test done");
    await turn;
  });

  it("does not respawn a paste the TUI acknowledged", async () => {
    vi.useFakeTimers();
    await warmSession("s-acked");

    const turn = engine.run({ sessionId: "s-acked", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
    expect(ptys).toHaveLength(1);

    hookCb!({ hook_event_name: "Stop", last_assistant_message: "ok" });
    expect((await turn).result).toBe("ok");
  });

  it("does not respawn while a tool is running: a queued prompt is not a lost one", async () => {
    vi.useFakeTimers();
    await warmSession("s-busy");

    void engine.run({ sessionId: "s-busy", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS * 2);
    expect(ptys).toHaveLength(1);
  });

  it("spawns nothing, and adopts nothing, when the turn is stopped mid-respawn", async () => {
    vi.useFakeTimers();
    await warmSession("s-stopped");

    let openGate!: () => void;
    proxyGate = new Promise((resolve) => { openGate = resolve; });
    const turn = engine.run({ sessionId: "s-stopped", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
    expect(ptys).toHaveLength(1); // respawn waiting on its proxy

    engine.kill("s-stopped", "Interrupted: stopped by user");
    expect((await turn).error).toMatch(/^Interrupted/);

    openGate();
    await vi.advanceTimersByTimeAsync(20);
    // The lifecycle may hold the next turn's PTY by now: a late spawn would
    // re-attach the session's stream and overwrite its recorded model.
    expect(ptys).toHaveLength(1);
    expect(engine.hasWarmPty("s-stopped")).toBe(false);
  });

  it("does not respawn when the local transcript shows the prompt arrived (its hook was lost)", async () => {
    vi.useFakeTimers();
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "jin3-cfg-"));
    const proj = path.join(cfg, "projects", "x");
    fs.mkdirSync(proj, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      await warmSession("s-lost-hook");
      void engine.run({ sessionId: "s-lost-hook", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      // Claude took the prompt; only its UserPromptSubmit hook went missing.
      fs.writeFileSync(path.join(proj, "c1.jsonl"), JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: "second" } }) + "\n");
      await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
      expect(ptys).toHaveLength(1);
    } finally { delete process.env.CLAUDE_CONFIG_DIR; }
  });

  it("still respawns when the only new transcript entry is somebody else's (a background re-run)", async () => {
    vi.useFakeTimers();
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "jin3-cfg-"));
    const proj = path.join(cfg, "projects", "x");
    fs.mkdirSync(proj, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      await warmSession("s-other-entry");
      void engine.run({ sessionId: "s-other-entry", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      fs.writeFileSync(path.join(proj, "c1.jsonl"), JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: "<task-notification>done</task-notification>" } }) + "\n");
      await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
      expect(ptys).toHaveLength(2);
    } finally { delete process.env.CLAUDE_CONFIG_DIR; }
  });

  it("the old PTY exiting mid-respawn does not interrupt the turn", async () => {
    vi.useFakeTimers();
    const warm = await warmSession("s-exit-mid");
    let openGate!: () => void;
    proxyGate = new Promise((resolve) => { openGate = resolve; });
    const turn = engine.run({ sessionId: "s-exit-mid", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
    expect(ptys).toHaveLength(1);
    warm.fireExit(); // the released PTY dies while the respawn is still starting
    await vi.advanceTimersByTimeAsync(6000); // past a watchdog tick too
    openGate();
    await vi.advanceTimersByTimeAsync(20);
    expect(ptys).toHaveLength(2);
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "second done" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("second done");
  });

  it("remote: stages nothing when the turn is stopped before staging", async () => {
    vi.useFakeTimers();
    await warmSession("s-remote-ready", REMOTE);
    expect(remote.stagings).toBe(1);

    let openReady!: () => void;
    remote.readyGate = new Promise((resolve) => { openReady = resolve; });
    const turn = engine.run({ sessionId: "s-remote-ready", prompt: "second", cwd: "/tmp", resumeSessionId: "c1", ...REMOTE } as any);
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS); // respawn waits on the host check

    engine.kill("s-remote-ready", "Interrupted: new message received");
    await turn;
    openReady();
    await vi.advanceTimersByTimeAsync(20);

    // Staging would have repointed the session's hook relay at a tunnel
    // nobody opens — the next PTY's hooks would go nowhere.
    expect(remote.stagings).toBe(1);
    expect(ptys).toHaveLength(1);
  });

  it("remote: spawns nothing when the turn is stopped while staging", async () => {
    vi.useFakeTimers();
    await warmSession("s-remote-stage", REMOTE);

    let openStage!: () => void;
    remote.stageGate = new Promise((resolve) => { openStage = resolve; });
    const turn = engine.run({ sessionId: "s-remote-stage", prompt: "second", cwd: "/tmp", resumeSessionId: "c1", ...REMOTE } as any);
    await vi.advanceTimersByTimeAsync(PAST_SUBMIT_RETRIES_MS);
    expect(remote.stagings).toBe(2); // the respawn is mid-staging

    engine.kill("s-remote-stage", "Interrupted: new message received");
    await turn;
    openStage();
    await vi.advanceTimersByTimeAsync(20);

    // No ssh spawned, so nothing re-attached the session's stream or recorded
    // the stopped turn's model as the live PTY's.
    expect(ptys).toHaveLength(1);
    expect(engine.hasWarmPty("s-remote-stage")).toBe(false);
  });
});

describe("viewportShowsRewindMenu", () => {
  const lines = (text: string) => text.split("\r\n");
  const STATUS = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

  it("the 2.1.283 capture is still recognised", () => {
    expect(viewportShowsRewindMenu(lines(REWIND_MENU_FRAME))).toBe(true);
    expect(viewportShowsRewindMenu([...lines(REWIND_MENU_FRAME), "", STATUS, ""])).toBe(true);
  });

  it("recognises both stages at 140, 50 and 30 columns (wrapped), live only with no composer below", () => {
    for (const frames of Object.values(REWIND_284)) {
      for (const rows of [frames.list, frames.moved, frames.confirm]) {
        expect(viewportShowsRewindMenu(rows)).toBe(true);
        // A transcript quoting the screen leaves claude's idle composer below it.
        expect(viewportShowsRewindMenu([...rows, "", "─".repeat(20), "❯ ", "─".repeat(20), STATUS])).toBe(false);
        expect(viewportShowsRewindMenu([...rows, "❯ half-typed draft"])).toBe(false);
      }
    }
  });

  it("needs the flow's own header, not just the word Rewind", () => {
    expect(viewportShowsRewindMenu(["The operator pressed Esc Esc and saw Rewind", "❯ "])).toBe(false);
    expect(viewportShowsRewindMenu(["   Rewind", "   something else entirely", "❯ "])).toBe(false);
    // A rewind list with no footer, and a confirm line with no numbered options.
    expect(viewportShowsRewindMenu(REWIND_284.f140.list.filter((l) => !l.includes("Enter to continue")))).toBe(false);
    expect(viewportShowsRewindMenu([
      "   Rewind",
      "   Confirm you want to restore to the point before you sent this message:",
      "❯ ",
    ])).toBe(false);
  });
});

describe("transcriptHasPromptSince", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jin3-transcript-"));
  const write = (name: string, lines: object[]) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  };
  const at = (iso: string) => Date.parse(iso);

  it("finds the prompt at or after the instant, however the paste reflowed it", () => {
    const p = write("a.jsonl", [
      { type: "user", timestamp: "2026-09-27T08:27:00.000Z", message: { content: "earlier" } },
      { type: "user", timestamp: "2026-09-27T08:31:02.000Z", message: { content: [{ type: "text", text: "context\n\nstaging is   clearly\nout of date, see `/tmp/a.png`" }] } },
    ]);
    expect(transcriptHasPromptSince(p, at("2026-09-27T08:31:00.000Z"), "staging is clearly out of date, see /tmp/a.png")).toBe(true);
  });

  it("ignores the prompt before the instant, other prompts, tool results, assistant text and an unreadable file", () => {
    const p = write("b.jsonl", [
      { type: "user", timestamp: "2026-09-27T08:27:00.000Z", message: { content: "the paste" } },
      { type: "user", timestamp: "2026-09-27T08:31:04.000Z", message: { content: "<task-notification>done</task-notification>" } },
      { type: "user", timestamp: "2026-09-27T08:31:05.000Z", message: { content: [{ type: "tool_result", content: "the paste" }] } },
      { type: "assistant", timestamp: "2026-09-27T08:31:06.000Z", message: { content: [{ type: "text", text: "the paste" }] } },
    ]);
    expect(transcriptHasPromptSince(p, at("2026-09-27T08:31:00.000Z"), "the paste")).toBe(false);
    expect(transcriptHasPromptSince(path.join(dir, "missing.jsonl"), 0, "the paste")).toBe(false);
  });
});
