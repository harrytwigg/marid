import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A prompt longer than one command-line argument may be. Linux refuses the
 * exec (MAX_ARG_STRLEN), node-pty's forked child prints the refusal and exits,
 * and the turn used to settle as a quiet interruption with the reason lost. It
 * must instead fail up front, saying how big the argument was and what the
 * limit is, and spawn nothing.
 */

const spawns: Array<{ bin: string; args: string[] }> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawns.push({ bin, args });
    return {
      pid: 5000 + spawns.length,
      _exitCode: null,
      onData() {},
      onExit() {},
      kill() {},
      write() {},
      resize() {},
      on() {},
    };
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41200; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine, buildInteractiveArgs, describeInteractiveArgument, spawnPrompt } from "../claude-interactive.js";
import { PtyLifecycleManager, plainOutputTail, processStartFailure } from "../pty-lifecycle.js";
import { MAX_ARGUMENT_BYTES, argumentLimitApplies, assertArgumentsFit, findOversizedArgument } from "../argv-limit.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 20));
const SID = "argv-limit-sess";

describe("findOversizedArgument", () => {
  it("accepts an argument of exactly the limit and refuses one byte more", () => {
    expect(MAX_ARGUMENT_BYTES).toBe(131_071);
    expect(findOversizedArgument(["a", "x".repeat(131_071)])).toBeUndefined();
    expect(findOversizedArgument(["a", "x".repeat(131_072)])).toEqual({ index: 1, bytes: 131_072 });
  });

  it("counts bytes, not characters", () => {
    // 50,000 characters, 150,000 bytes of UTF-8.
    expect(findOversizedArgument(["€".repeat(50_000)])).toEqual({ index: 0, bytes: 150_000 });
  });
});

describe("argumentLimitApplies", () => {
  it("binds a local spawn on Linux only, and a remote spawn everywhere", () => {
    expect(argumentLimitApplies(false, "linux")).toBe(true);
    expect(argumentLimitApplies(false, "darwin")).toBe(false);
    expect(argumentLimitApplies(true, "darwin")).toBe(true);
  });
});

describe("assertArgumentsFit", () => {
  it("names the argument, its size and the limit, and is not an interruption", () => {
    const args = ["--model", "sonnet", "--", "p".repeat(136_066)];
    expect(() => assertArgumentsFit("Claude Code", args, (i) => describeInteractiveArgument(args, i))).toThrow(
      "Claude Code cannot be started with this turn: the message (with its attachment list) is 136,066 bytes, "
      + "over the operating system's limit of 131,071 bytes for one command-line argument. "
      + "Shorten it, or send the long text as an attached file.",
    );
  });
});

describe("describeInteractiveArgument", () => {
  const args = buildInteractiveArgs({ prompt: "hello", settingsPath: "/tmp/s.json", appendSystemPrompt: "persona" });
  it("names the message, the system prompt, and anything else by position", () => {
    expect(describeInteractiveArgument(args, args.length - 1)).toBe("the message (with its attachment list)");
    expect(describeInteractiveArgument(args, args.indexOf("persona"))).toBe("the system prompt");
    expect(describeInteractiveArgument(args, 0)).toBe("command-line argument 1");
  });
});

describe("spawnPrompt", () => {
  it("passes a fresh session's message alone: the system prompt travels in its own flag", () => {
    expect(spawnPrompt({ prompt: "hello", systemPrompt: "# persona" } as any)).toBe("hello");
  });

  it("still carries a resumed session's platform-context refresh", () => {
    expect(spawnPrompt({ prompt: "hello", resumeSessionId: "c1", platformContextRefresh: "## refresh" })).toBe("## refresh\n\nhello");
  });
});

describe("processStartFailure", () => {
  it("carries the process's last output as one plain line", () => {
    expect(processStartFailure("claude", { exitCode: 1, signal: 0 }, "\x1b[31mexecvp(3) failed.: No such file or directory\r\n"))
      .toBe("claude did not start: its process exited (code 1, signal 0) before its session began. Its last output: execvp(3) failed.: No such file or directory");
    expect(processStartFailure("claude", { exitCode: 1 })).toBe("claude did not start: its process exited (code 1, signal unknown) before its session began, with no output");
  });

  it("keeps only the end of a long output", () => {
    const tail = plainOutputTail(`${"noise ".repeat(200)}the real reason`, 40);
    expect(tail.endsWith("the real reason")).toBe(true);
    expect(tail.length).toBe(41);
  });
});

describe("InteractiveClaudeEngine — a prompt too long for one argument", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;
  const realPlatform = process.platform;

  beforeEach(() => {
    spawns.length = 0;
    // The cap is Linux's; hold the test to it on any host.
    Object.defineProperty(process, "platform", { value: "linux" });
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  it("fails the turn up front, naming the size and the limit, and spawns nothing", async () => {
    await expect(engine.run({ sessionId: SID, prompt: "p".repeat(136_066), cwd: "/tmp" } as any))
      .rejects.toThrow(/^Claude Code cannot be started with this turn: the message \(with its attachment list\) is 136,066 bytes, over the operating system's limit of 131,071 bytes/);
    expect(spawns).toHaveLength(0);
  });

  it("names the system prompt when that is the argument too long", async () => {
    await expect(engine.run({ sessionId: SID, prompt: "hi", systemPrompt: "s".repeat(140_000), cwd: "/tmp" } as any))
      .rejects.toThrow(/the system prompt is 140,\d{3} bytes/);
    expect(spawns).toHaveLength(0);
  });

  it("sends the system prompt once, in its flag, and not again in front of the message", async () => {
    // Each fits its own argument; folded together they would not.
    void engine.run({ sessionId: SID, prompt: "m".repeat(80_000), systemPrompt: "s".repeat(80_000), cwd: "/tmp" } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(1);
    const args = spawns[0].args;
    expect(args[args.length - 1]).toBe("m".repeat(80_000));
    expect(args[args.indexOf("--append-system-prompt") + 1].startsWith("s".repeat(80_000))).toBe(true);
  });

  it("spawns a prompt that fits", async () => {
    void engine.run({ sessionId: SID, prompt: "p".repeat(120_000), cwd: "/tmp" } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args[spawns[0].args.length - 1]).toHaveLength(120_000);
  });

  it("does not bind a local spawn on macOS, which has no per-argument cap", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    void engine.run({ sessionId: SID, prompt: "p".repeat(136_066), cwd: "/tmp" } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(1);
  });
});
