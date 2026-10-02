import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

/**
 * The opencode engine's remote branch.
 *
 * The guarantee is the same negative one the Pi and interactive Claude remote
 * tests hold: for a remote employee NOTHING runs on the gateway. A local
 * opencode and a remote one are indistinguishable in the UI — same events, same
 * answer — so a regression here would quietly run the workload on the
 * orchestrator, against a repository that is not there.
 *
 * The second guarantee is about the transport. opencode's protocol is a prompt
 * on stdin and newline-delimited JSON on stdout, and both halves have to survive
 * the ssh hop — hence the assertions on the absence of a remote tty and on what
 * the child's stdin actually receives. The third is about the secret: this
 * session's capability travels in a 0600 file, and must not appear on a command
 * line that every process on that host can read.
 */

// Per session AND per engine: a substituted session must not restage the home
// the engine it was substituted FROM is still reading gateway.json out of.
const REMOTE_HOME = "/home/builder/.jinn-remote-stage/sessions/sess-1__opencode";
const REMOTE_BIN = "/home/builder/.local/bin/opencode";

interface FakeProc {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  kill: () => boolean;
  unref: () => void;
  on: (event: string, cb: (arg: number | Error) => void) => FakeProc;
  /** Test-side: end the process with this status, as a remote exit would. */
  close: (code: number) => void;
}

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; opts: Record<string, unknown> }[],
  stdinWrites: [] as string[],
  prepareCalls: [] as Record<string, unknown>[],
  ensureCalls: [] as Record<string, unknown>[],
  /** Every pre-spawn reap of a previous turn's agent, with the spawn count at the time. */
  reaps: [] as { handle: Record<string, unknown>; engineName: string; spawnsSoFar: number }[],
  /** Flipped by one case to prove an unready host never reaches spawn. */
  ready: true,
  /** Flipped by one case to drop the staged opencode config. */
  withConfig: true,
  /** When set, the TURN's ssh client stays open until the test closes it —
   *  the shape of a run that is still going when an interrupt arrives. */
  hang: false,
  /** The turn's fake client, for the test to close. */
  turn: null as null | { close: (code: number) => void },
  /** Every control ssh (`sh -s …`) the engine opened, with the script it sent. */
  controls: [] as { args: string[]; stdin: string; opts: Record<string, unknown> }[],
  /** What the fake remote host answers a kill with. */
  killAnswer: "terminated",
  /** How long the fake host takes to answer. */
  controlDelayMs: 5,
  /** Signals sent to the local process group, in order, with the kill's tick. */
  localSignals: [] as { signal: string; controlsDone: number }[],
  controlsDone: 0,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: Record<string, unknown>) => {
    hoisted.spawns.push({ bin, args, opts });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const isControl = /^sh -s /.test(args[args.length - 1] ?? "");
    let controlStdin = "";
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        if (isControl) controlStdin += String(chunk);
        else hoisted.stdinWrites.push(String(chunk));
        cb();
      },
    });
    let onClose: ((code: number) => void) | null = null;
    const proc: FakeProc = {
      pid: isControl ? 5150 : 4242,
      exitCode: null,
      killed: false,
      stdout,
      stderr,
      stdin,
      kill: () => true,
      unref: () => {},
      close(code: number) {
        if (proc.exitCode !== null) return;
        stdout.end();
        proc.exitCode = code;
        onClose?.(code);
      },
      on(event: string, cb: (arg: number | Error) => void) {
        if (event !== "close") return proc;
        onClose = cb as (code: number) => void;
        if (isControl) {
          // The remote host runs the kill script and answers with one word.
          setTimeout(() => {
            hoisted.controls.push({ args, stdin: controlStdin, opts });
            hoisted.controlsDone += 1;
            stdout.write(`${hoisted.killAnswer}\n`);
            proc.close(0);
          }, hoisted.controlDelayMs);
          return proc;
        }
        hoisted.turn = proc;
        if (hoisted.hang) return proc;
        setTimeout(() => {
          stdout.write(`${JSON.stringify({
            type: "text",
            sessionID: "ses_remote1",
            part: { type: "text", text: "done on the desktop" },
          })}\n`);
          proc.close(0);
        }, 0);
        return proc;
      },
    };
    return proc;
  }),
}));

// Only the two functions that would talk to a real host are replaced. The argv
// builder and its shell quoting stay REAL, so every assertion below is made
// against the command that would genuinely be sent.
vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    reapStaleRemoteEngine: vi.fn(async (handle: Record<string, unknown>, engineName: string) => {
      hoisted.reaps.push({ handle, engineName, spawnsSoFar: hoisted.spawns.length });
    }),
    ensureRemoteReady: vi.fn(async (target: unknown, remote: unknown, opts: Record<string, unknown>) => {
      hoisted.ensureCalls.push({ target, remote, opts });
      if (!hoisted.ready) return { ready: false, reason: "build-box is not reachable" };
      return {
        ready: true,
        facts: {
          home: "/home/builder",
          stageDir: "/home/builder/.jinn-remote-stage",
          nodeBin: "/home/builder/.nvm/versions/node/v22.22.3/bin/node",
          opencodeBin: REMOTE_BIN,
          jinnVersion: "0.32.0",
          entryDir: "/home/builder/.nvm/versions/node/v22.22.3/lib/node_modules/jinn-cli/dist/src/mcp",
        },
      };
    }),
    prepareRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
      hoisted.prepareCalls.push(opts);
      return {
        engine: "opencode",
        destination: "builder@build-box",
        tunnelPort: 44321,
        sessionHome: REMOTE_HOME,
        envFilePath: `${REMOTE_HOME}/tmp/session-env.sh`,
        ...(hoisted.withConfig ? { opencodeConfigPath: `${REMOTE_HOME}/tmp/opencode.json` } : {}),
      };
    }),
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { REMOTE_KILL_SCRIPT } from "../remote-stage.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";

const REMOTE_CONFIG = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };
const GATEWAY_PORT = 8722;

function engine(gatewayPort = GATEWAY_PORT): OpencodeEngine {
  return new OpencodeEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => gatewayPort });
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return {
    prompt: "build it",
    cwd: JINN_HOME,
    sessionId: "sess-1",
    model: "anthropic/claude-sonnet-5",
    remoteHost: "build-box",
    remoteUser: "builder",
    remoteCwd: "/srv/jinn-work/proj",
    ...over,
  };
}

/** The remote command is the last argv element of the ssh invocation. */
function remoteCommand(): string {
  return hoisted.spawns[0]!.args.at(-1)!;
}

/** The local group signal `signalProcess` sends, recorded rather than sent. */
const processKill = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
  if (pid === -4242) hoisted.localSignals.push({ signal: String(signal), controlsDone: hoisted.controlsDone });
  return true;
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  hoisted.spawns = [];
  hoisted.stdinWrites = [];
  hoisted.prepareCalls = [];
  hoisted.ensureCalls = [];
  hoisted.reaps = [];
  hoisted.ready = true;
  hoisted.withConfig = true;
  hoisted.hang = false;
  hoisted.turn = null;
  hoisted.controls = [];
  hoisted.killAnswer = "terminated";
  hoisted.controlDelayMs = 5;
  hoisted.localSignals = [];
  hoisted.controlsDone = 0;
  processKill.mockClear();
});

describe("OpencodeEngine — a remote employee's turn runs on the other machine", () => {
  it("spawns ssh, never the gateway's own opencode", async () => {
    const result = await engine().run(runOpts());

    expect(result.result).toBe("done on the desktop");
    expect(hoisted.spawns).toHaveLength(1);
    expect(hoisted.spawns[0]!.bin).toMatch(/(^|[\\/])ssh(\.exe)?$/);
    // The opencode that runs is the REMOTE install's, found on that host's PATH.
    expect(remoteCommand()).toContain(REMOTE_BIN);
    expect(remoteCommand()).toContain("cd '/srv/jinn-work/proj'");
  });

  it("asks the host about opencode's CLI, not another engine's", async () => {
    await engine().run(runOpts());

    expect(hoisted.ensureCalls[0]!.opts).toMatchObject({ engine: "opencode", allowWake: false });
    expect(hoisted.prepareCalls[0]).toMatchObject({ engine: "opencode", jinnSessionId: "sess-1" });
  });

  it("allocates no remote tty, so the JSON stdout is not interleaved with stderr", async () => {
    // With `-tt` the remote process gets ONE stream: stderr lands in the middle
    // of the newline-delimited JSON this engine parses, and a run's real error
    // reads as an unparseable line and is dropped.
    await engine().run(runOpts());

    expect(hoisted.spawns[0]!.args).toContain("-T");
    expect(hoisted.spawns[0]!.args).not.toContain("-tt");
  });

  it("sends the prompt over stdin, so it never reaches that host's process table", async () => {
    await engine().run(runOpts({ prompt: "rewrite the secret handler" }));

    expect(hoisted.stdinWrites.join("")).toBe("rewrite the secret handler");
    expect(remoteCommand()).not.toContain("rewrite the secret handler");
  });

  it("runs the same argv a local turn would", async () => {
    await engine().run(runOpts({ resumeSessionId: "ses_earlier" }));

    const command = remoteCommand();
    expect(command).toContain("'run' '--format' 'json' '--dangerously-skip-permissions'");
    expect(command).toContain("'-m' 'anthropic/claude-sonnet-5'");
    expect(command).toContain("'-s' 'ses_earlier'");
  });

  it("points opencode at the staged config and this session's home", async () => {
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).toContain(`OPENCODE_CONFIG='${REMOTE_HOME}/tmp/opencode.json'`);
    expect(command).toContain(`JINN_HOME='${REMOTE_HOME}'`);
    // A self-upgrade mid-session would swap the binary under a conversation
    // opencode is still holding in its own store on that host.
    expect(command).toContain("OPENCODE_DISABLE_AUTOUPDATE='1'");
  });

  it("sets no OPENCODE_CONFIG when the session staged none", async () => {
    // Nothing staged → opencode's own config on that host is left alone, rather
    // than pointed at a file that does not exist.
    hoisted.withConfig = false;

    await engine().run(runOpts());

    expect(remoteCommand()).not.toContain("OPENCODE_CONFIG");
  });

  it("sources the 0600 env file instead of putting secrets on the command line", async () => {
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).toContain(`. '${REMOTE_HOME}/tmp/session-env.sh' &&`);
    // The bearer and the capability live in that file and in the staged config.
    // Everything on a remote command line is readable by every process on that
    // host, so neither may ever be inlined here.
    expect(command).not.toContain("JINN_GATEWAY_TOKEN");
    expect(command).not.toContain("JINN_SESSION_CAPABILITY");
  });

  it("leaves the operator's provider keys alone", async () => {
    // Deliberate, and the opposite of the Claude engine's rule: opencode drives
    // whichever provider the operator authenticated on that machine, and for a
    // key-authenticated provider an inherited key is how it works at all.
    // Claude Code strips them because it runs on subscription auth, where an
    // inherited key would silently move the session onto metered billing.
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).not.toContain("'-u' 'ANTHROPIC_API_KEY'");
    expect(command).not.toContain("'-u' 'OPENAI_API_KEY'");
    // What IS stripped: the markers that tell a nested CLI it is inside another agent.
    expect(command).toContain("'-u' 'CLAUDECODE'");
  });

  it("puts the remote node and the instance bin on PATH", async () => {
    // An MCP server launched as bare `node` has none on a version-manager host,
    // and the tools the operating instructions name bare live in the farm.
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).toContain("/home/builder/.nvm/versions/node/v22.22.3/bin");
    expect(command).toContain(`${REMOTE_HOME}/bin`);
  });

  it("forwards the reverse tunnel to the gateway's real port", async () => {
    await engine().run(runOpts());

    expect(hoisted.spawns[0]!.args).toContain("-R");
    expect(hoisted.spawns[0]!.args).toContain(`44321:127.0.0.1:${GATEWAY_PORT}`);
  });

  it("refuses to spawn without a gateway port", async () => {
    // The forward would be built as `-R n:127.0.0.1:0`, and every jinn tool call
    // would answer into nothing while the turn ran on regardless.
    await expect(engine(0).run(runOpts())).rejects.toThrow(/gateway's port/);
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("never spawns for a host that is not ready", async () => {
    hoisted.ready = false;

    await expect(engine().run(runOpts())).rejects.toThrow(/build-box is not reachable/);
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("names an attachment by the path the other machine sees it at, not the gateway's", async () => {
    const file = path.join(JINN_HOME, "uploads", "2026-10-02", "sess-1", "diagram.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "png");

    await engine().run(runOpts({ attachments: [file] }));

    const prompt = hoisted.stdinWrites.join("");
    expect(prompt).toContain(`- ${REMOTE_HOME}/uploads/2026-10-02/sess-1/diagram.png`);
    expect(prompt).not.toContain(JINN_HOME);
  });

  it("fails the turn, spawning nothing, for an attachment the policy refuses", async () => {
    const secret = path.join(JINN_HOME, "secrets", "api-keys.json");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "{}");

    await expect(engine().run(runOpts({ attachments: [secret] }))).rejects.toThrow(/api-keys\.json.*secrets/i);
    expect(hoisted.spawns).toHaveLength(0);
  });
});

/**
 * The interrupt has to reach the opencode on the OTHER host.
 *
 * The local ssh client runs with no tty (see above), and sshd does not signal
 * a no-tty command when its channel closes — the pipes go dead and opencode,
 * which ignores EPIPE, carries on. Verified on a real host during an
 * interrupted remote turn ran for 18 more minutes and committed into the
 * worktree its successor had already been resumed on. So a kill is a control
 * connection that terminates the recorded pid, and the local client is only
 * signalled once that has come back — the turn settles when the client closes,
 * and the next turn starts on that settle.
 */
describe("OpencodeEngine — an interrupt terminates the remote opencode, not just the ssh client", () => {
  const PID_FILE = `${REMOTE_HOME}/tmp/engine.pid`;

  it("records the remote pid before exec, where the kill will look for it", async () => {
    await engine().run(runOpts());

    // `$$` is the remote shell's pid and `exec` hands it to opencode, so the
    // file names opencode itself — no wrapper process to kill instead.
    // The pid AND its start time: exec keeps both, a recycled pid matches neither.
    expect(remoteCommand()).toContain(`printf '%s\\n%s\\n' "$$" "$(ps -o lstart= -p $$ 2>/dev/null)" > '${PID_FILE}' && exec env`);
  });

  it("reaps a previous turn's opencode before spawning, in case one outlived a crashed gateway", async () => {
    await engine().run(runOpts());

    expect(hoisted.reaps).toHaveLength(1);
    expect(hoisted.reaps[0]).toMatchObject({
      engineName: "opencode",
      handle: { destination: "builder@build-box", pidFile: PID_FILE, bin: REMOTE_BIN },
      // Before the turn's ssh client exists, never beside it.
      spawnsSoFar: 0,
    });
  });

  it("kills over a control connection FIRST, and the local client only after the host answers", async () => {
    hoisted.hang = true;
    const eng = engine();
    const run = eng.run(runOpts());
    await tick();
    expect(hoisted.turn).not.toBeNull();

    eng.kill("sess-1", "Interrupted by user");
    await tick(40);

    // One control ssh, carrying the kill script on stdin and naming the pid
    // file, the binary to check against pid reuse, and the grace period.
    expect(hoisted.controls).toHaveLength(1);
    const control = hoisted.controls[0]!;
    expect(control.args.at(-1)).toBe(`sh -s '${PID_FILE}' '${REMOTE_BIN}' '5'`);
    expect(control.args).toContain("builder@build-box");
    expect(control.stdin).toBe(REMOTE_KILL_SCRIPT);
    // Spawned to outlive the gateway: a kill sent during shutdown must land
    // even if the 5s force-exit fires first.
    expect(control.opts.detached).toBe(true);

    // The local SIGTERM came AFTER the host had answered, never before.
    expect(hoisted.localSignals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    expect(hoisted.localSignals[0]!.controlsDone).toBe(1);

    // The channel closes because opencode exited; the turn reports the interrupt.
    hoisted.turn!.close(143);
    const result = await run;
    expect(result.error).toBe("Interrupted by user");
  });

  it("does not settle until the kill has reported, even though the client closes first", async () => {
    // The client closes the moment opencode dies on SIGTERM; the script is
    // still sweeping descendants for up to the grace period. A tool child
    // that ignored SIGTERM would otherwise outlive the settle — and meet the
    // next turn.
    hoisted.hang = true;
    hoisted.controlDelayMs = 60;
    const eng = engine();
    let settled = false;
    const run = eng.run(runOpts()).then((r) => { settled = true; return r; });
    await tick();

    eng.kill("sess-1", "Interrupted by user");
    await tick(10);
    hoisted.turn!.close(143);
    await tick(10);
    expect(settled).toBe(false);
    expect(hoisted.controlsDone).toBe(0);

    await tick(80);
    expect(hoisted.controlsDone).toBe(1);
    expect(settled).toBe(true);
    expect((await run).error).toBe("Interrupted by user");
  });

  it("looks again when the kill found nothing but the client was closed by our own signal", async () => {
    // The interrupt landed while the turn was still connecting: the pid file
    // had not been written, so the kill answered already-gone and the local
    // client was signalled. The remote shell may have exec'd opencode in the
    // meantime — the file is there now, so the kill runs once more.
    hoisted.hang = true;
    hoisted.killAnswer = "already-gone";
    const eng = engine();
    const run = eng.run(runOpts());
    await tick();

    eng.kill("sess-1", "Interrupted by user");
    await tick(40);
    expect(hoisted.controls).toHaveLength(1);
    expect(hoisted.localSignals.map((s) => s.signal)).toEqual(["SIGTERM"]);

    // Closed by OUR signal, not by the remote side ending.
    hoisted.turn!.close(null as unknown as number);
    await tick(40);
    expect(hoisted.controls).toHaveLength(2);
    expect((await run).error).toBe("Interrupted by user");
  });

  it("does not look again when the client closed because the remote side ended", async () => {
    hoisted.hang = true;
    hoisted.killAnswer = "already-gone";
    const eng = engine();
    const run = eng.run(runOpts());
    await tick();

    eng.kill("sess-1");
    await tick(40);
    // The remote command's own exit status came through: opencode is gone.
    hoisted.turn!.close(0);
    await tick(40);
    expect(hoisted.controls).toHaveLength(1);
    await run;
  });

  it("still kills the local client when the host cannot be reached, and says so", async () => {
    hoisted.hang = true;
    hoisted.killAnswer = "ssh: connect to host build-box port 22: No route to host";
    const eng = engine();
    const run = eng.run(runOpts());
    await tick();

    eng.kill("sess-1");
    await tick(40);

    // An unreachable host is not a reason to leave the operator's interrupt
    // hanging: the client is signalled anyway, and the turn settles.
    expect(hoisted.localSignals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    hoisted.turn!.close(null as unknown as number);
    const result = await run;
    expect(result.error).toBe("Interrupted");
  });

  it("opens one control connection for one process, however many times it is asked", async () => {
    hoisted.hang = true;
    const eng = engine();
    const run = eng.run(runOpts());
    await tick();

    // An operator interrupt followed at once by a gateway shutdown.
    eng.kill("sess-1", "Interrupted by user");
    eng.killAll();
    await tick(40);

    expect(hoisted.controls).toHaveLength(1);
    hoisted.turn!.close(143);
    await run;
  });

  it("a client that drops on its own (255) has the remote process killed before the turn settles", async () => {
    // A network blip closes the channel without anyone signalling opencode.
    // Settling straight away would let the next turn start beside it.
    hoisted.hang = true;
    const eng = engine();
    const run = eng.run(runOpts());
    await tick();

    hoisted.turn!.close(255);
    await tick(40);

    expect(hoisted.controls).toHaveLength(1);
    const result = await run;
    expect(result.error).toMatch(/exited with code 255/);
  });

  it("a turn that ends on its own opens no control connection", async () => {
    await engine().run(runOpts());
    await tick();

    expect(hoisted.controls).toHaveLength(0);
    expect(hoisted.localSignals).toHaveLength(0);
  });

  it("a LOCAL turn is signalled directly, with no control connection", async () => {
    hoisted.hang = true;
    const eng = engine();
    const run = eng.run({ prompt: "build it", cwd: JINN_HOME, sessionId: "sess-1", model: "anthropic/claude-sonnet-5" });
    await tick();

    eng.kill("sess-1");
    await tick(40);

    expect(hoisted.controls).toHaveLength(0);
    expect(hoisted.localSignals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    hoisted.turn!.close(143);
    await run;
  });
});
