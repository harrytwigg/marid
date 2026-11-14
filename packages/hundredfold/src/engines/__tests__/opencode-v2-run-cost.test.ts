import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";

/**
 * An OpenCode 2 `run` turn is charged what opencode recorded for its messages.
 *
 * 2.x's `--format json` stream carries a `step_finish` for a step that ended on
 * a tool call and none for the step that answers, so the turn is charged from
 * `api session.message.list` once the process is gone. 1.x keeps its stream.
 */

const hoisted = vi.hoisted(() => ({
  version: "2.0.32" as string | undefined,
  /** stdout lines of the turn */
  events: [] as object[],
  /** what the cost read prints, or null for a read that fails */
  messages: null as string | null,
  spawns: [] as { bin: string; args: string[]; env: Record<string, string | undefined> }[],
  /** how long the cost read takes to answer */
  readDelayMs: 0,
  reads: [] as { bin: string; args: string[]; env: Record<string, string | undefined>; cwd: unknown }[],
  ssh: [] as { destination: string; args: string[] }[],
  sshStdout: null as string | null,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => {
    hoisted.spawns.push({ bin, args, env: { ...(opts?.env ?? {}) } });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    const proc = {
      pid: 4242,
      exitCode: null as number | null,
      killed: false,
      stdout,
      stderr,
      stdin,
      kill: () => true,
      unref: () => {},
      on(event: string, cb: (arg: number) => void) {
        if (event !== "close") return proc;
        setTimeout(() => {
          for (const e of hoisted.events) stdout.write(`${JSON.stringify(e)}\n`);
          stdout.end();
          proc.exitCode = 0;
          cb(0);
        }, 0);
        return proc;
      },
    };
    return proc;
  }),
  execFile: vi.fn((bin: string, args: string[], opts: { env?: Record<string, string>; cwd?: unknown }, cb: (err: Error | null, stdout: string) => void) => {
    hoisted.reads.push({ bin, args, env: { ...(opts.env ?? {}) }, cwd: opts.cwd });
    setTimeout(() => (hoisted.messages === null ? cb(new Error("boom"), "") : cb(null, hoisted.messages)), hoisted.readDelayMs);
    return { stdin: { end: () => {} } };
  }),
}));

vi.mock("../../shared/opencode-bin-version.js", () => ({
  localOpencodeVersion: vi.fn(async () => hoisted.version),
  clearOpencodeVersionCache: vi.fn(),
}));

vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    reapStaleRemoteEngine: vi.fn(async () => {}),
    sshRun: vi.fn(async (destination: string, args: string[]) => {
      hoisted.ssh.push({ destination, args });
      return hoisted.sshStdout === null ? { code: 255, stdout: "", stderr: "down" } : { code: 0, stdout: hoisted.sshStdout, stderr: "" };
    }),
    ensureRemoteReady: vi.fn(async () => ({
      ready: true,
      facts: {
        home: "/home/builder",
        stageDir: "/home/builder/.hundredfold-remote-stage",
        nodeBin: "/home/builder/.nvm/versions/node/v22.22.3/bin/node",
        opencodeBin: "/home/builder/.local/bin/opencode",
        opencodeVersion: hoisted.version,
        hundredfoldVersion: "0.33.3",
        entryDir: "/home/builder/.nvm/versions/node/v22.22.3/lib/node_modules/hundredfold/dist/src/mcp",
      },
    })),
    prepareRemoteSession: vi.fn(async () => ({
      engine: "opencode",
      destination: "builder@build-box",
      tunnelPort: 44321,
      sessionHome: "/home/builder/.hundredfold-remote-stage/sessions/sess-1__opencode",
      envFilePath: "/home/builder/.hundredfold-remote-stage/sessions/sess-1__opencode/tmp/session-env.sh",
    })),
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { RemoteKills } from "../remote-stage.js";
import { HUNDREDFOLD_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";
import { runCostArgs, turnCostFromMessages } from "../opencode-v2-run-cost.js";

const SES = "ses_run_cost";
const FIRST = "msg_0002";

const step = (type: string, messageID: string, part: object = {}) => ({ type, sessionID: SES, part: { type, messageID, ...part } });
const message = (id: string, cost: number | undefined, type = "assistant") => ({ id, type, ...(cost === undefined ? {} : { cost }) });
/** `api session.message.list` output: newest first. */
const listing = (...messages: object[]) => JSON.stringify({ data: messages, cursor: {} });

/** A turn that called a tool and then answered: opencode 2.x finishes only the first step on the stream. */
const TOOL_TURN = [
  step("step_start", FIRST),
  step("tool_use", FIRST, { tool: "shell", state: { status: "completed", input: {}, output: "ok" } }),
  step("step_finish", FIRST, { reason: "tool-calls", cost: 0.004, tokens: { input: 1000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
  step("step_start", "msg_0003"),
  step("text", "msg_0003", { text: "done" }),
];
const PLAIN_TURN = [step("step_start", FIRST), step("text", FIRST, { text: "pong" })];

function opts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "go", cwd: HUNDREDFOLD_HOME, sessionId: "sess-1", model: "mock/m1", resumeSessionId: SES, ...over };
}

const REMOTE = { root: "/srv/agents", mount: "/mnt/hundredfold-home" };
const engine = () => new OpencodeEngine({ remote: () => REMOTE, gatewayPort: () => 8722 });

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  hoisted.version = "2.0.32";
  hoisted.events = PLAIN_TURN;
  hoisted.messages = listing(message(FIRST, 0.00405), message("msg_0001", 0.5));
  hoisted.spawns = [];
  hoisted.readDelayMs = 0;
  hoisted.reads = [];
  hoisted.ssh = [];
  hoisted.sshStdout = null;
});

describe("turnCostFromMessages", () => {
  it("sums the assistant messages from the turn's first to the newest, and stops there", () => {
    const out = listing(message("msg_0003", 0.003), message("msg_0002", 0.002), message("msg_0001", 0.5));
    expect(turnCostFromMessages(out, "msg_0002")).toBeCloseTo(0.005, 10);
  });

  it("skips messages that are not assistant ones, and an assistant one with no cost", () => {
    const out = listing(message("msg_0004", undefined, "idle"), message("msg_0003", undefined), message("msg_0002", 0.002, "user"), message("msg_0001", 0.25));
    expect(turnCostFromMessages(out, "msg_0001")).toBe(0.25);
  });

  it("says nothing when the turn's first message is not in the list", () => {
    expect(turnCostFromMessages(listing(message("msg_0003", 0.003)), "msg_0002")).toBeUndefined();
  });

  it("says nothing for output that is not a message list", () => {
    expect(turnCostFromMessages("not json", "msg_0002")).toBeUndefined();
    expect(turnCostFromMessages(JSON.stringify({ _tag: "SessionNotFoundError" }), "msg_0002")).toBeUndefined();
  });

  it("asks for the newest assistant messages of the session through a private server", () => {
    expect(runCostArgs(SES)).toEqual([
      "api", "--standalone", "session.message.list",
      "--param", `sessionID=${SES}`, "--param", "order=desc", "--param", "limit=200", "--param", "type=assistant",
    ]);
  });
});

describe("opencode 2.x `run` turn cost", () => {
  it("records the cost opencode recorded for a turn that streamed no step_finish", async () => {
    const result = await engine().run(opts());
    expect(result.error).toBeUndefined();
    expect(result.cost).toBeCloseTo(0.00405, 10);
    expect(hoisted.reads).toHaveLength(1);
    expect(hoisted.reads[0]!.args).toEqual(runCostArgs(SES));
  });

  it("charges the answering step the stream left out, once, for a turn that called a tool", async () => {
    hoisted.events = TOOL_TURN;
    hoisted.messages = listing(message("msg_0003", 0.003), message(FIRST, 0.004), message("msg_0001", 0.5));
    const result = await engine().run(opts());
    // The stream carried 0.004; the record has 0.004 + 0.003 and replaces it rather than adding to it.
    expect(result.cost).toBeCloseTo(0.007, 10);
  });

  it("reads the cost from the session the turn ran in, which opencode named", async () => {
    const result = await engine().run(opts({ resumeSessionId: undefined }));
    expect(result.sessionId).toBe(SES);
    expect(hoisted.reads[0]!.args).toContain(`sessionID=${SES}`);
  });

  it("does not hand the cost read the staged config the turn's cleanup deletes", async () => {
    // A command timeout stages a config for the turn itself, so there is one to withhold.
    await new OpencodeEngine({ commandTimeoutMs: () => 60_000 }).run(opts());
    expect(hoisted.spawns[0]!.env.OPENCODE_CONFIG).toBeTruthy();
    expect(hoisted.reads[0]!.env.OPENCODE_CONFIG).toBeUndefined();
    expect(hoisted.reads[0]!.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  });

  it("answers with the finished turn when a stop lands while its cost is being read", async () => {
    hoisted.readDelayMs = 80;
    const eng = engine();
    const running = eng.run(opts());
    await new Promise((r) => setTimeout(r, 30));
    expect(hoisted.reads).toHaveLength(1);
    eng.kill("sess-1", "Interrupted");
    const result = await running;
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("pong");
    expect(result.cost).toBeCloseTo(0.00405, 10);
  });

  it("reads a remote turn's cost only once the remote process is known to be gone", async () => {
    let released = () => {};
    const gone = new Promise<void>((resolve) => { released = resolve; });
    vi.spyOn(RemoteKills.prototype, "beforeSettle").mockImplementation(() => gone);
    hoisted.sshStdout = listing(message(FIRST, 0.00405));
    const running = engine().run(opts({ remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/agents/proj" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(hoisted.ssh).toEqual([]);
    released();
    const result = await running;
    expect(hoisted.ssh).toHaveLength(1);
    expect(result.cost).toBeCloseTo(0.00405, 10);
  });

  it("keeps the turn and what its stream carried when the cost cannot be read", async () => {
    hoisted.events = TOOL_TURN;
    hoisted.messages = null;
    const result = await engine().run(opts());
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("done");
    expect(result.cost).toBeCloseTo(0.004, 10);
  });

  it("keeps the stream's cost when the turn's first message is not in the record", async () => {
    hoisted.events = TOOL_TURN;
    hoisted.messages = listing(message("msg_0009", 9));
    expect((await engine().run(opts())).cost).toBeCloseTo(0.004, 10);
  });

  it("does not read anything for a turn whose stream named no message", async () => {
    hoisted.events = [{ type: "error", sessionID: SES, error: { name: "X", data: { message: "no key" } } }];
    const result = await engine().run(opts());
    expect(result.error).toBeTruthy();
    expect(hoisted.reads).toEqual([]);
    expect(result.cost).toBeUndefined();
  });

  it("charges a turn that failed after a step ran", async () => {
    hoisted.events = [...PLAIN_TURN, { type: "error", sessionID: SES, error: { name: "X", data: { message: "late" } } }];
    const result = await engine().run(opts());
    expect(result.error).toBeTruthy();
    expect(result.cost).toBeCloseTo(0.00405, 10);
  });

  it("reads a remote turn's cost over ssh from the remote host's opencode", async () => {
    hoisted.sshStdout = listing(message(FIRST, 0.00405));
    const result = await engine().run(opts({ remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/agents/proj" }));
    expect(result.cost).toBeCloseTo(0.00405, 10);
    expect(hoisted.reads).toEqual([]);
    expect(hoisted.ssh).toHaveLength(1);
    expect(hoisted.ssh[0]!.destination).toBe("builder@build-box");
    expect(hoisted.ssh[0]!.args[0]).toBe(
      `'/home/builder/.local/bin/opencode' 'api' '--standalone' 'session.message.list' '--param' 'sessionID=${SES}' `
      + "'--param' 'order=desc' '--param' 'limit=200' '--param' 'type=assistant'",
    );
  });
});

describe("opencode 2.x `run` turn on a declared account", () => {
  const KEY = "ACME_GO_B_KEY";
  const staging = {
    providers: () => ({}),
    unservedModel: () => undefined,
    env: { [KEY]: "sk-run-cost-b" },
    fingerprint: "fp",
    scrub: [KEY, "ACME_GO_C_KEY"],
  };

  it("charges the account's model the cost opencode recorded, and keeps the key out of the cost read", async () => {
    const result = await new OpencodeEngine({ accounts: () => staging }).run(opts({ model: "opencode-go-b/flash" }));
    expect(result.error).toBeUndefined();
    expect(result.cost).toBeCloseTo(0.00405, 10);
    expect(hoisted.spawns[0]!.env[KEY]).toBe("sk-run-cost-b");
    expect(hoisted.reads).toHaveLength(1);
    expect(hoisted.reads[0]!.env[KEY]).toBeUndefined();
    expect(hoisted.reads[0]!.env.ACME_GO_C_KEY).toBeUndefined();
  });
});

describe("opencode 1.x `run` turn cost is untouched", () => {
  it("never asks opencode for the cost, local or remote", async () => {
    hoisted.version = "1.19.0";
    hoisted.events = [...PLAIN_TURN, step("step_finish", FIRST, { reason: "stop", cost: 0.02, tokens: { input: 5, output: 1 } })];
    const local = await engine().run(opts());
    expect(local.cost).toBeCloseTo(0.02, 10);
    const remote = await engine().run(opts({ remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/agents/proj" }));
    expect(remote.cost).toBeCloseTo(0.02, 10);
    expect(hoisted.reads).toEqual([]);
    expect(hoisted.ssh).toEqual([]);
  });
});
