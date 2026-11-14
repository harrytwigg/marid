import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => recordSpawn(bin, args, opts)),
}));

import { CodexEngine } from "../codex.js";
import type { EngineResult, StreamDelta } from "../../shared/types.js";
import { costOfUsage } from "../../shared/model-pricing.js";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import {
  agentMessage,
  cmdEnd,
  cmdStart,
  errorItem,
  flush,
  recordSpawn,
  resetSpawnCalls,
  runWith,
  sleep,
  spawnCalls,
  threadStarted,
  turnCompleted,
  turnFailed,
} from "./helpers/codex-run.js";

beforeEach(resetSpawnCalls);

describe("CodexEngine — JSONL stream parsing into deltas", () => {
  it("maps an agent_message item to a text delta via onStream", async () => {
    const { deltas } = await runWith({}, [threadStarted("t1"), agentMessage("Hello world")]);
    expect(deltas).toContainEqual({ type: "text", content: "Hello world" });
  });

  it("maps command_execution start/end to tool_use and tool_result deltas", async () => {
    const { deltas } = await runWith({}, [
      threadStarted("t1"),
      cmdStart("c1", "ls -la"),
      cmdEnd("ls -la", 0, "file1\nfile2"),
      agentMessage("done"),
    ]);
    expect(deltas).toContainEqual({
      type: "tool_use",
      content: "Running: ls -la",
      toolName: "command_execution",
      toolId: "c1",
    });
    expect(deltas).toContainEqual({
      type: "tool_result",
      content: "ls -la (exit 0): file1\nfile2",
    });
  });

  it("skips malformed/garbage JSONL lines gracefully without crashing", async () => {
    const { result, deltas } = await runWith({}, [
      "this is not json {{{",
      "",
      "   ",
      threadStarted("t1"),
      "<another garbage line>",
      agentMessage("survived"),
    ]);
    expect(result.result).toBe("survived");
    // Only the real agent_message produced a text delta.
    expect(deltas.filter((d) => d.type === "text")).toEqual([{ type: "text", content: "survived" }]);
  });

  it("suppresses benign error notices (e.g. web_search_request) — not surfaced as error delta", async () => {
    const { deltas, result } = await runWith({}, [
      threadStarted("t1"),
      errorItem("web_search_request is deprecated"),
      agentMessage("real answer"),
    ]);
    expect(deltas.find((d) => d.type === "error")).toBeUndefined();
    expect(result.result).toBe("real answer");
    expect(result.error).toBeUndefined();
  });

  it("surfaces a genuine error item as an error delta", async () => {
    const { deltas } = await runWith({}, [
      threadStarted("t1"),
      errorItem("something genuinely broke"),
    ]);
    expect(deltas).toContainEqual({ type: "error", content: "something genuinely broke" });
  });
});

describe("CodexEngine — final result assembly (last agent_message wins, NOT concatenated)", () => {
  it("uses the FINAL agent_message, replacing earlier ones (= not +=)", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("preamble: let me think..."),
      agentMessage("intermediate note"),
      agentMessage("FINAL ANSWER"),
    ]);
    // If the code concatenated, result would contain all three. It must be ONLY
    // the last one.
    expect(result.result).toBe("FINAL ANSWER");
    expect(result.result).not.toContain("preamble");
    expect(result.result).not.toContain("intermediate");
  });

  it("separates adjacent live agent_message blocks without changing the final result", async () => {
    const { result, deltas } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("First block."),
      agentMessage("Second block."),
    ]);

    const liveText = deltas.filter((d) => d.type === "text").map((d) => d.content).join("");
    expect(liveText).toBe("First block.\n\nSecond block.");
    expect(result.result).toBe("Second block.");
  });

  it("flushes a trailing agent_message that arrives without a newline (close-time lineBuf)", async () => {
    const { result } = await runWith(
      {},
      [threadStarted("t1"), agentMessage("earlier")],
      { trailingNoNewline: agentMessage("last via buffer flush") },
    );
    expect(result.result).toBe("last via buffer flush");
  });

  it("returns the thread id from thread.started as sessionId", async () => {
    const { result } = await runWith({}, [threadStarted("thread-xyz"), agentMessage("ok")]);
    expect(result.sessionId).toBe("thread-xyz");
  });
});

describe("CodexEngine — systemPrompt / developer_instructions injection", () => {
  it("prepends systemPrompt to the prompt on the FIRST turn (no resumeSessionId)", async () => {
    const { call } = await runWith(
      { systemPrompt: "YOU ARE JIMBO" },
      [threadStarted("t1"), agentMessage("ok")],
    );
    // Fresh args: ["exec", ..., <prompt>] — prompt is the last arg.
    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).toContain("YOU ARE JIMBO");
    expect(finalArg).toContain("---");
    expect(finalArg).toContain("hello");
    expect(call.args[0]).toBe("exec");
    expect(call.args).not.toContain("resume");
  });

  it("does not refresh platform session context on a plain resume turn", async () => {
    const { call } = await runWith(
      {
        systemPrompt: [
          "# You are Jimbo",
          "YOU ARE JIMBO",
          "## Current session",
          "- Session ID: duplicated-hundredfold-session",
          "## Current configuration",
          "- Gateway: http://127.0.0.1:7777",
          "## Organization",
          "- Should not be repeated on resume",
        ].join("\n"),
        resumeSessionId: "prev-thread",
      },
      [threadStarted("t2"), agentMessage("ok")],
    );
    // Resume args: ["exec", "resume", ..., <resumeId>, <prompt>] — prompt last.
    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).not.toContain("## Hundredfold platform context refresh");
    expect(finalArg).not.toContain("- Session ID: duplicated-hundredfold-session");
    expect(finalArg).not.toContain("- Gateway: http://127.0.0.1:7777");
    expect(finalArg).not.toContain("YOU ARE JIMBO");
    expect(finalArg).not.toContain("Should not be repeated on resume");
    expect(finalArg).toContain("hello");
    expect(call.args[0]).toBe("exec");
    expect(call.args[1]).toBe("resume");
    expect(call.args).toContain("prev-thread");
  });

  it("includes an explicitly supplied platform context refresh on resume", async () => {
    const refresh = "## Hundredfold platform context refresh\n- Active engine: codex";
    const { call } = await runWith(
      {
        systemPrompt: "# Full system context",
        resumeSessionId: "prev-thread",
        platformContextRefresh: refresh,
      } as any,
      [threadStarted("t2"), agentMessage("ok")],
    );

    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).toBe(`${refresh}\n\nhello`);
  });

  it("appends attachments to the prompt", async () => {
    const { call } = await runWith(
      { attachments: ["/tmp/a.png", "/tmp/b.txt"] },
      [threadStarted("t1"), agentMessage("ok")],
    );
    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).toContain("Attached files:");
    expect(finalArg).toContain("- /tmp/a.png");
    expect(finalArg).toContain("- /tmp/b.txt");
  });

  it("drops Claude-only --chrome cliFlags before spawning codex exec", async () => {
    const { call } = await runWith(
      { cliFlags: ["--chrome", "--some-codex-flag"] },
      [threadStarted("t1"), agentMessage("ok")],
    );
    expect(call.args).not.toContain("--chrome");
    expect(call.args).toContain("--some-codex-flag");
  });

  it("drops Claude-only --chrome cliFlags on resume too", async () => {
    const { call } = await runWith(
      { resumeSessionId: "prev-thread", cliFlags: ["--chrome"] },
      [threadStarted("t1"), agentMessage("ok")],
    );
    expect(call.args).not.toContain("--chrome");
    expect(call.args).toContain("prev-thread");
  });

  it("carries the bound hundredfold capability via a per-session CODEX_HOME config.toml, never argv, and persists the home across the turn", async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    // A stand-in "real" ~/.codex the overlay links auth.json from + merges config.
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-home-"));
    fs.writeFileSync(path.join(realHome, "auth.json"), JSON.stringify({ token: "login" }));
    fs.writeFileSync(path.join(realHome, "config.toml"), 'approval_policy = "never"\n');
    process.env.CODEX_HOME = realHome;
    const homesBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-base-"));
    const capability = "capability-secret-for-home";
    const sessionId = "sess-capability-home";
    try {
      const engine = new CodexEngine({
        codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-sessions-")),
        codexHomesBaseDir: homesBaseDir,
      });
      const promise = engine.run({
        prompt: "hello",
        cwd: "/tmp",
        sessionId,
        resolvedMcp: {
          mcpServers: {
            hundredfold: {
              command: "/usr/bin/node",
              args: ["/abs/server-entry.js"],
              env: {
                HUNDREDFOLD_GATEWAY_URL: "http://127.0.0.1:7777",
                HUNDREDFOLD_HOME: "/tmp/hundredfold-home",
                HUNDREDFOLD_SESSION_ID: sessionId,
                HUNDREDFOLD_SESSION_CAPABILITY: capability,
              },
            },
          },
        },
      } as any);
      await flush();
      const call = spawnCalls[spawnCalls.length - 1];
      const joined = call.args.join(" ");
      // Capability + --profile never touch argv (the whole point of the fix).
      expect(joined).not.toContain(capability);
      expect(joined).not.toContain("HUNDREDFOLD_SESSION_CAPABILITY");
      expect(call.args).not.toContain("--profile");

      // CODEX_HOME points at the stable per-session overlay dir.
      const expectedHome = path.join(homesBaseDir, sessionId);
      expect((call.opts as { env?: Record<string, string> }).env?.CODEX_HOME).toBe(expectedHome);

      // config.toml is 0600, carries the capability, and merged the operator base.
      const cfgPath = path.join(expectedHome, "config.toml");
      expectPosixMode(fs.statSync(cfgPath), 0o600);
      const cfg = fs.readFileSync(cfgPath, "utf-8");
      expect(cfg).toContain(`HUNDREDFOLD_SESSION_CAPABILITY = ${JSON.stringify(capability)}`);
      expect(cfg).toContain('approval_policy = "never"'); // operator base preserved
      // auth.json symlinked back to the real codex home.
      expect(fs.lstatSync(path.join(expectedHome, "auth.json")).isSymbolicLink()).toBe(true);

      call.proc.emitStdout(`${threadStarted("t-home")}\n${agentMessage("ok")}\n`);
      call.proc.close(0);
      await promise;
      // The overlay PERSISTS after the turn — resume needs the rollout under it.
      expect(fs.existsSync(cfgPath)).toBe(true);
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(realHome, { recursive: true, force: true });
      fs.rmSync(homesBaseDir, { recursive: true, force: true });
    }
  });
});

describe("CodexEngine — usage / context-token extraction", () => {
  it("prices only the cumulative usage added by each turn", async () => {
    const engine = new CodexEngine({
      codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-cost-sessions-")),
    });
    const run = async (usage: Record<string, unknown>, answer: string) => {
      const promise = engine.run({
        prompt: answer,
        cwd: "/tmp",
        sessionId: "cost-session",
        model: "gpt-5.5",
      } as any);
      await flush();
      const call = spawnCalls[spawnCalls.length - 1]!;
      call.proc.emitStdout([
        threadStarted("cost-thread"),
        agentMessage(answer),
        turnCompleted(usage),
        "",
      ].join("\n"));
      call.proc.close(0);
      return promise;
    };

    const first = await run(
      { input_tokens: 5_000, cached_input_tokens: 1_200, output_tokens: 600 },
      "first",
    );
    expect(first.cost).toBe(costOfUsage("gpt-5.5", {
      inputTokens: 3_800,
      cachedInputTokens: 1_200,
      outputTokens: 600,
    }));

    const second = await run(
      { input_tokens: 8_000, cached_input_tokens: 2_200, output_tokens: 1_000 },
      "second",
    );
    expect(second.cost).toBe(costOfUsage("gpt-5.5", {
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      outputTokens: 400,
    }));
  });

  it("does not use flat turn.completed input_tokens as contextTokens (headless Codex reports it cumulatively)", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("ok"),
      turnCompleted({ input_tokens: 1000, cached_input_tokens: 300, output_tokens: 50 }),
    ]);
    expect(result.contextTokens).toBeUndefined();
  });

  it("increments numTurns per turn.completed event", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({ input_tokens: 100, last_token_usage: { input_tokens: 100 } }),
      turnCompleted({ input_tokens: 300, last_token_usage: { input_tokens: 200 } }),
    ]);
    expect(result.numTurns).toBe(2);
    // Last turn's per-turn usage wins, not cumulative input_tokens.
    expect(result.contextTokens).toBe(200);
  });

  it("omits contextTokens when usage is missing or input_tokens is zero/invalid", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({ output_tokens: 50 }), // no input_tokens
    ]);
    expect(result.contextTokens).toBeUndefined();
  });

  it("omits cumulative Codex usage values from contextTokens", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({ input_tokens: 310_356, output_tokens: 50 }),
    ]);
    expect(result.contextTokens).toBeUndefined();
  });

  it("uses nested last_token_usage when available instead of cumulative totals", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({
        input_tokens: 9_282_000,
        last_token_usage: { input_tokens: 42_000, output_tokens: 50 },
      }),
    ]);
    expect(result.contextTokens).toBe(42_000);
  });

  it("backfills headless contextTokens from the Codex rollout transcript", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-context-"));
    const dir = path.join(root, "2026", "06", "11");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rollout-2026-06-11T00-00-00-thread-rollout.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-rollout" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 9_282_000 },
              last_token_usage: { input_tokens: 58_463, cached_input_tokens: 5_000 },
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const { result } = await runWith(
      {},
      [
        threadStarted("thread-rollout"),
        agentMessage("ok"),
        turnCompleted({ input_tokens: 494_290, output_tokens: 50 }),
      ],
      { engineOpts: { codexSessionsDir: root } },
    );
    expect(result.contextTokens).toBe(58_463);
  });

  it("backfills contextTokens from the active per-session CODEX_HOME rollout", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-home-"));
    const homesBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-base-"));
    const sessionId = "hundredfold-session-overlay";
    const threadId = "thread-overlay";
    const rolloutDir = path.join(homesBaseDir, sessionId, "sessions", "2026", "07", "20");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolloutDir, "rollout-2026-07-20T00-00-00-thread-overlay.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 63_250, cached_input_tokens: 5_000 } },
          },
        }),
        "",
      ].join("\n"),
    );
    process.env.CODEX_HOME = realHome;

    try {
      const { result } = await runWith(
        {
          sessionId,
          resolvedMcp: {
            mcpServers: {
              hundredfold: {
                command: "/usr/bin/node",
                args: ["/abs/server-entry.js"],
                env: { HUNDREDFOLD_SESSION_CAPABILITY: "cap-overlay" },
              },
            },
          },
        },
        [
          threadStarted(threadId),
          agentMessage("ok"),
          turnCompleted({ input_tokens: 494_290, output_tokens: 50 }),
        ],
        { engineOpts: { codexHomesBaseDir: homesBaseDir } },
      );

      expect(result.contextTokens).toBe(63_250);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(realHome, { recursive: true, force: true });
      fs.rmSync(homesBaseDir, { recursive: true, force: true });
    }
  });
});

describe("CodexEngine — error / failure handling", () => {
  it("does not surface a turn error when a non-empty answer was produced", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      turnFailed("transient hiccup"),
      agentMessage("but here is the answer"),
    ]);
    expect(result.result).toBe("but here is the answer");
    // Non-empty result.trim() => error is suppressed.
    expect(result.error).toBeUndefined();
  });

  it("surfaces turn_failed as error when there is no answer text", async () => {
    const { result } = await runWith({}, [threadStarted("t1"), turnFailed("hard failure")], {
      closeCode: 0,
    });
    expect(result.result).toBe("");
    expect(result.error).toBe("hard failure");
  });

  it("reports a non-zero exit with no thread id as an error", async () => {
    const { result } = await runWith({}, [], { closeCode: 1 });
    expect(result.error).toMatch(/Codex exited with code 1/);
  });

  it("falls back to a fresh thread when resume fails because the rollout is missing", async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-home-"));
    const homesBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-base-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.CODEX_HOME = realHome;

    try {
      const engine = new CodexEngine({
        codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-missing-rollout-")),
        codexHomesBaseDir: homesBaseDir,
      });
      const promise = engine.run({
        prompt: "hello",
        cwd: "/tmp",
        sessionId: "sess-missing-rollout",
        resumeSessionId: "lost-thread",
        resolvedMcp: {
          mcpServers: {
            hundredfold: {
              command: "/usr/bin/node",
              args: ["/abs/server-entry.js"],
              env: {
                HUNDREDFOLD_GATEWAY_URL: "http://127.0.0.1:7777",
                HUNDREDFOLD_HOME: "/tmp/hundredfold-home",
                HUNDREDFOLD_SESSION_ID: "sess-missing-rollout",
                HUNDREDFOLD_SESSION_CAPABILITY: "cap-missing-rollout",
              },
            },
          },
        },
      } as any);

      await flush();
      const resumeCall = spawnCalls[0];
      expect(resumeCall.args.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(resumeCall.args).toContain("lost-thread");
      expect((resumeCall.opts as { env?: Record<string, string> }).env?.CODEX_HOME)
        .toBe(path.join(homesBaseDir, "sess-missing-rollout"));

      resumeCall.proc.emitStderr(
        'thread/resume failed: no rollout found for thread id "lost-thread" (code -32600)\n',
      );
      resumeCall.proc.close(1);
      await flush();

      expect(spawnCalls).toHaveLength(2);
      const freshCall = spawnCalls[1];
      expect(freshCall.args[0]).toBe("exec");
      expect(freshCall.args[1]).not.toBe("resume");
      expect(freshCall.args).not.toContain("lost-thread");
      expect((freshCall.opts as { env?: Record<string, string> }).env?.CODEX_HOME)
        .toBe(path.join(homesBaseDir, "sess-missing-rollout"));

      freshCall.proc.emitStdout(`${threadStarted("fresh-thread")}\n${agentMessage("fresh answer")}\n`);
      freshCall.proc.close(0);

      const result = await promise;
      expect(result).toMatchObject({ sessionId: "fresh-thread", result: "fresh answer" });
      expect(result.error).toBeUndefined();
      expect(
        logSpy.mock.calls.some(([line]) =>
          String(line).includes("[WARN]") &&
          String(line).includes("lost-thread") &&
          String(line).includes("no rollout found"),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(realHome, { recursive: true, force: true });
      fs.rmSync(homesBaseDir, { recursive: true, force: true });
    }
  });
});

describe("CodexEngine — process lifecycle", () => {
  it("exports the Hundredfold session id to spawned commands", async () => {
    const engine = new CodexEngine({
      codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-env-")),
    });
    const promise = engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "sess-env",
    } as any);

    const call = spawnCalls[spawnCalls.length - 1];
    expect((call.opts as any).env.HUNDREDFOLD_SESSION_ID).toBe("sess-env");

    call.proc.emitStdout(threadStarted("t-env") + "\n" + agentMessage("done") + "\n");
    call.proc.close(0);
    await promise;
  });

  it("tracks a live process and clears it after close (isAlive)", async () => {
    const engine = new CodexEngine({
      codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-alive-")),
    });
    const promise = engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "sess-1",
    } as any);
    expect(engine.isAlive("sess-1")).toBe(true);

    const call = spawnCalls[spawnCalls.length - 1];
    call.proc.emitStdout(threadStarted("t1") + "\n" + agentMessage("done") + "\n");
    call.proc.close(0);
    await promise;
    expect(engine.isAlive("sess-1")).toBe(false);
  });

  it("settles on the terminal turn.completed event even if the process never closes", async () => {
    // Regression (same hang class as grok 94a50cc): a bash/shell tool call can leave
    // a grandchild that inherits codex's stdout pipe, so proc.on("close") never fires
    // even after codex itself exits. The turn must still settle from the parsed
    // terminal event (turn.completed) — never hang.
    const engine = new CodexEngine({
      codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-hang-")),
    });
    const deltas: StreamDelta[] = [];
    const promise = engine.run({
      prompt: "run a bash command",
      cwd: "/tmp",
      sessionId: "codex-session-hang",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();

    // Stream thread id + answer + the terminal turn.completed. Crucially we NEVER
    // call call.proc.close(...) — the pipe is "held open" by a grandchild.
    call.proc.emitStdout(
      [
        threadStarted("thread-hang"),
        agentMessage("Done — the command ran."),
        turnCompleted({ last_token_usage: { input_tokens: 1234 } }),
        "",
      ].join("\n"),
    );

    // Resolves promptly from the terminal event (no close). A 1s race guard proves
    // we do not depend on `close` (which would hang here, failing pre-fix).
    const raced = await Promise.race([promise, sleep(1000).then(() => "TIMED_OUT" as const)]);
    expect(raced).not.toBe("TIMED_OUT");
    const result = raced as EngineResult;
    expect(result).toMatchObject({
      sessionId: "thread-hang",
      result: "Done — the command ran.",
      numTurns: 1,
      contextTokens: 1234,
    });
    expect(result.error).toBeUndefined();
    expect(engine.isAlive("codex-session-hang")).toBe(false);
  });

  it("backfills overlay contextTokens when settling without a process close", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-home-"));
    const homesBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-homes-base-"));
    const sessionId = "hundredfold-session-terminal-overlay";
    const threadId = "thread-terminal-overlay";
    const rolloutDir = path.join(homesBaseDir, sessionId, "sessions", "2026", "07", "20");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolloutDir, "rollout-2026-07-20T00-00-00-thread-terminal-overlay.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 71_000, cached_input_tokens: 4_000 } },
          },
        }),
        "",
      ].join("\n"),
    );
    process.env.CODEX_HOME = realHome;

    try {
      const engine = new CodexEngine({
        codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-terminal-sessions-")),
        codexHomesBaseDir: homesBaseDir,
      });
      const promise = engine.run({
        prompt: "hello",
        cwd: "/tmp",
        sessionId,
        resolvedMcp: {
          mcpServers: {
            hundredfold: {
              command: "/usr/bin/node",
              args: ["/abs/server-entry.js"],
              env: { HUNDREDFOLD_SESSION_CAPABILITY: "cap-terminal-overlay" },
            },
          },
        },
      } as any);

      await flush();
      const call = spawnCalls[spawnCalls.length - 1];
      call.proc.emitStdout(
        [
          threadStarted(threadId),
          agentMessage("ok"),
          turnCompleted({ input_tokens: 494_290, output_tokens: 50 }),
          "",
        ].join("\n"),
      );

      const raced = await Promise.race([promise, sleep(1000).then(() => "TIMED_OUT" as const)]);
      expect(raced).not.toBe("TIMED_OUT");
      expect((raced as EngineResult).contextTokens).toBe(71_000);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(realHome, { recursive: true, force: true });
      fs.rmSync(homesBaseDir, { recursive: true, force: true });
    }
  });

  it("kill() sets the termination reason as the result error", async () => {
    const engine = new CodexEngine();
    let resolved: EngineResult | undefined;
    void engine
      .run({ prompt: "hi", cwd: "/tmp", sessionId: "sess-2" } as any)
      .then((r) => (resolved = r));
    await flush();

    engine.kill("sess-2", "Interrupted: new message");
    const call = spawnCalls[spawnCalls.length - 1];
    // Process eventually closes after the kill signal.
    call.proc.close(null);
    await flush();
    expect(resolved?.error).toBe("Interrupted: new message");
  });
});

describe("CodexEngine — reset time on a quota failure", () => {
  /** A rollout carrying one `token_count` with the account's rate-limit snapshot. */
  function rolloutWithRateLimits(threadId: string, resetsAt: number): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-"));
    const dir = path.join(root, "2026", "08", "19");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `rollout-2026-08-19T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 100, window_minutes: 10_080, resets_at: resetsAt },
              secondary: null,
            },
          },
        }),
        "",
      ].join("\n"),
    );
    return root;
  }

  it("prefers the reset codex stated in its rate_limits snapshot", async () => {
    const resetsAt = 1_787_200_992;
    const root = rolloutWithRateLimits("thread-quota", resetsAt);
    const { result } = await runWith(
      {},
      [
        threadStarted("thread-quota"),
        turnFailed("You've hit your usage limit. Try again at 2026-08-19T18:30:00.000Z."),
      ],
      { engineOpts: { codexSessionsDir: root } },
    );
    expect(result.rateLimit).toEqual({ status: "rejected", resetsAt });
  });

  it("falls back to the reset stated in the error prose", async () => {
    const { result } = await runWith(
      {},
      [
        threadStarted("thread-prose"),
        turnFailed("You've hit your usage limit. Try again at 2026-08-19T18:30:00.000Z."),
      ],
      { engineOpts: { codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-prose-")) } },
    );
    expect(result.rateLimit).toEqual({
      status: "rejected",
      resetsAt: Math.floor(Date.parse("2026-08-19T18:30:00.000Z") / 1000),
    });
  });

  it("never invents a reset when neither source states one", async () => {
    const { result } = await runWith({}, [threadStarted("thread-bare"), turnFailed("429 rate limit exceeded")]);
    expect(result.rateLimit).toEqual({ status: "rejected" });
    expect(result.rateLimit?.resetsAt).toBeUndefined();
  });

  it("leaves an ordinary failure unmarked", async () => {
    const { result } = await runWith({}, [threadStarted("thread-plain"), turnFailed("the build step exited with code 1")]);
    expect(result.rateLimit).toBeUndefined();
  });
});
