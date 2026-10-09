import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts, JinnConfig, Session } from "../../../shared/types.js";
import type { TurnInput, TurnPlan } from "../types.js";

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn(() => undefined) }));
vi.mock("../../../gateway/budgets.js", () => ({ isBudgetExhausted: vi.fn(() => false) }));
vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: vi.fn(() => true),
  effortLevelsForModel: vi.fn(() => []),
}));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  getMessages: vi.fn(() => []),
  getSession: vi.fn(() => undefined),
}));
const mcp = vi.hoisted(() => ({ jinn: true }));
vi.mock("../../engine-run-mcp.js", () => ({
  resolveEngineRunMcp: vi.fn(() => ({ mcpConfigPath: undefined, resolvedMcp: { mcpServers: mcp.jinn ? { jinn: {} } : { other: {} } } })),
}));
const rateLimit = vi.hoisted(() => ({ prompt: undefined as string | undefined }));
vi.mock("../../rate-limit-handler.js", () => ({
  handleRateLimit: vi.fn(async (args: { prompt: string }) => {
    rateLimit.prompt = args.prompt;
    return { kind: "cancelled" };
  }),
}));

import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { preflightTurn } from "../preflight.js";
import { runEngineAttempt } from "../engine-run.js";
import { runRateLimitTurn } from "../rate-limit-turn.js";
import { spawnPrompt } from "../../../engines/claude-interactive.js";
import { buildOpencodePrompt } from "../../../engines/opencode-protocol.js";
import { buildResumeMessage } from "../../self-compaction.js";
import {
  BOARD_REMINDER_LABEL,
  DEFAULT_BOARD_REMINDER,
  resolveBoardReminder,
  withBoardReminder,
  withoutBoardReminder,
} from "../board-reminder.js";

const LINE = `${BOARD_REMINDER_LABEL} ${DEFAULT_BOARD_REMINDER}`;
const ENGINES = ["claude", "opencode", "codex"];

function configWith(context?: JinnConfig["context"]): JinnConfig {
  return {
    engines: { default: "claude", claude: {}, codex: {}, opencode: { mode: "server" } },
    ...(context ? { context } : {}),
  } as unknown as JinnConfig;
}

function input(engine: string, prompt: string, over: { config?: JinnConfig; resuming?: boolean } = {}): TurnInput {
  const session = {
    id: "s1", engine, source: "web", status: "running", attemptToken: "t",
    engineSessions: over.resuming === false ? {} : { [engine]: { id: `${engine}-native-1` } },
  } as unknown as Session;
  return {
    session, attemptToken: "t", prompt, attachments: [], config: over.config ?? configWith(),
    engines: new Map(ENGINES.map((e) => [e, {} as never])), gatewayBootId: "boot",
    connectorNames: [], channel: "web", user: "operator",
  } as TurnInput;
}

/** The opts the engine is called with for this turn, with a fixed system prompt in place of the built one. */
async function engineOpts(turn: TurnInput): Promise<EngineRunOpts> {
  const planned = preflightTurn(turn) as TurnPlan;
  expect(planned.ok).toBe(true);
  let seen: EngineRunOpts | undefined;
  const plan: TurnPlan = {
    ...planned,
    engine: { name: turn.session.engine, run: async (opts: EngineRunOpts) => { seen = opts; return { result: "", sessionId: "x" }; } } as never,
    prepareContext: () => ({ fingerprint: "f", refresh: planned.resumeSessionId ? "REFRESH" : undefined, systemPrompt: "SYSTEM" }),
  };
  await runEngineAttempt({
    input: turn, plan, model: undefined, turnStartedAt: Date.now(),
    surface: {} as never, heartbeat: { beat: vi.fn(), stop: vi.fn() } as never, partialStream: { persist: vi.fn(), finish: vi.fn() } as never,
  });
  return seen!;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  mcp.jinn = true;
  rateLimit.prompt = undefined;
});

describe("board reminder text", () => {
  it("keeps the default line, label included, under 60 o200k_base tokens", () => {
    expect(new Tiktoken(o200k).encode(LINE).length).toBeLessThanOrEqual(60);
  });

  it("uses the built-in text when the instance sets none", () => {
    expect(resolveBoardReminder(configWith(), true)).toBe(DEFAULT_BOARD_REMINDER);
  });

  it("takes an instance's own text in place of the default", () => {
    const config = configWith({ boardReminder: "Board: QA before in_review." });
    expect(resolveBoardReminder(config, true)).toBe("Board: QA before in_review.");
  });

  it("lets an instance extend the default through {{default}}", () => {
    const config = configWith({ boardReminder: "{{default}} Open a PR before in_review." });
    expect(resolveBoardReminder(config, true))
      .toBe(`${DEFAULT_BOARD_REMINDER} Open a PR before in_review.`);
  });

  it.each([false, "", "   "] as const)("is off when the instance sets %j", (boardReminder) => {
    expect(resolveBoardReminder(configWith({ boardReminder }), true)).toBeUndefined();
  });

  it("is never carried by a session without the jinn MCP server", () => {
    expect(resolveBoardReminder(configWith(), false)).toBeUndefined();
  });

  it("appends one labelled line after the message, or stands alone when the message is empty", () => {
    expect(withBoardReminder("hello", "R")).toBe(`hello\n\n${BOARD_REMINDER_LABEL} R`);
    expect(withBoardReminder("  ", "R")).toBe(`${BOARD_REMINDER_LABEL} R`);
    expect(withBoardReminder("hello", undefined)).toBe("hello");
  });

  it.each(["/compact", "/init", "/code-review high", "  /review 12"])("leaves the slash command %j alone", (command) => {
    expect(withBoardReminder(command, "R")).toBe(command);
  });

  it("takes the appended line back off a prompt read from a transcript, and nothing else", () => {
    expect(withoutBoardReminder(withBoardReminder("hello\n\nthere", DEFAULT_BOARD_REMINDER))).toBe("hello\n\nthere");
    expect(withoutBoardReminder(withBoardReminder("hello", "Board: custom.\nSecond line."))).toBe("hello");
    expect(withoutBoardReminder(withBoardReminder("", DEFAULT_BOARD_REMINDER))).toBe("");
    expect(withoutBoardReminder("hello")).toBe("hello");
    const quoted = `the line reads ${BOARD_REMINDER_LABEL} and so on`;
    expect(withoutBoardReminder(quoted)).toBe(quoted);
  });
});

describe("board reminder in the engine prompt", () => {
  it.each([true, false])("claude: the prompt ends with the reminder exactly once (resuming: %s)", async (resuming) => {
    const opts = await engineOpts(input("claude", "please look at the Todo", { resuming }));
    const sent = spawnPrompt(opts);
    expect(sent.endsWith(`please look at the Todo\n\n${LINE}`)).toBe(true);
    expect(count(sent, BOARD_REMINDER_LABEL)).toBe(1);
    if (resuming) expect(sent.startsWith("REFRESH\n\n")).toBe(true);
  });

  it.each([true, false])("opencode: the prompt ends with the reminder exactly once (resuming: %s)", async (resuming) => {
    const opts = await engineOpts(input("opencode", "please look at the Todo", { resuming }));
    const sent = buildOpencodePrompt(opts);
    expect(sent.endsWith(`please look at the Todo\n\n${LINE}`)).toBe(true);
    expect(count(sent, BOARD_REMINDER_LABEL)).toBe(1);
    expect(sent.startsWith("SYSTEM\n\n---\n\n")).toBe(!resuming);
  });

  it("is added when the engine is called, not to the planned prompt the turn records", () => {
    const turn = input("claude", "please look at the Todo");
    const plan = preflightTurn(turn) as TurnPlan;
    expect(plan.promptToRun).toBe("please look at the Todo");
    expect(plan.boardReminder).toBe(DEFAULT_BOARD_REMINDER);
    expect(turn.prompt).toBe("please look at the Todo");
  });

  it("rides the resume turn a self-compaction queues", async () => {
    const resume = buildResumeMessage({ goal: "g", done: "d", next: "n" });
    const opts = await engineOpts(input("claude", resume));
    expect(opts.prompt).toBe(`${resume}\n\n${LINE}`);
  });

  it.each([
    ["claude", "/compact keep the Todo ids"],
    ["opencode", "/compact"],
    ["claude", "/clear"],
    ["claude", "/init"],
    ["claude", "/code-review high"],
    ["codex", "/review"],
  ])("leaves %s's slash command %j exactly as written", async (engine, command) => {
    const opts = await engineOpts(input(engine, command));
    expect(opts.prompt).toBe(command);
  });

  it("is left out for a session without the jinn MCP server", async () => {
    mcp.jinn = false;
    const opts = await engineOpts(input("codex", "hello"));
    expect(opts.prompt).toBe("hello");
  });

  it("carries the instance's override", async () => {
    const opts = await engineOpts(input("claude", "hello", { config: configWith({ boardReminder: "Board: custom." }) }));
    expect(opts.prompt).toBe(`hello\n\n${BOARD_REMINDER_LABEL} Board: custom.`);
  });

  it("rides the retry after a usage limit", async () => {
    const turn = input("claude", "hello");
    const plan = preflightTurn(turn) as TurnPlan;
    await runRateLimitTurn({
      input: turn, plan, surface: {} as never, systemPrompt: "SYSTEM", platformContextRefresh: undefined,
      rateLimit: {} as never, originalResult: {} as never,
    } as never);
    expect(rateLimit.prompt).toBe(`hello\n\n${LINE}`);
  });
});
