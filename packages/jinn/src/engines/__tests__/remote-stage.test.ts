import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure-surface tests for the remote staging module. Nothing here touches SSH:
 * the two things worth proving without a second machine are the shell quoting
 * (which is all that stands between a prompt and remote command injection) and
 * the argv/remote-command construction.
 */

// ── dgram capture ────────────────────────────────────────────────────────────
// sendWakeOnLan broadcasts to 255.255.255.255, which a bound loopback socket
// cannot observe. Capture the datagram at the socket boundary instead.
interface SentPacket { buffer: Buffer; offset: number; length: number; port: number; address: string }
const sent: SentPacket[] = [];
let broadcastSet = false;
let closed = false;

vi.mock("node:dgram", () => {
  const createSocket = (_type: string) => {
    const handlers = new Map<string, (...a: any[]) => void>();
    return {
      once(event: string, cb: (...a: any[]) => void) { handlers.set(event, cb); },
      on(event: string, cb: (...a: any[]) => void) { handlers.set(event, cb); },
      bind(cb: () => void) { setImmediate(cb); },
      setBroadcast(_on: boolean) { broadcastSet = true; },
      // Rest-typed to match dgram's 6-argument send without tripping max-params.
      send(...a: [Buffer, number, number, number, string, (err?: Error) => void]) {
        const [buffer, offset, length, port, address, cb] = a;
        sent.push({ buffer: Buffer.from(buffer), offset, length, port, address });
        setImmediate(() => cb());
      },
      close() { closed = true; },
    };
  };
  return { default: { createSocket }, createSocket };
});

import { REMOTE_ENGINE_NAMES } from "../../shared/models.js";
import Database from "better-sqlite3";
import { REMOTE_STAGE_MARKER } from "../../shared/remote-farm.js";
import { isRemoteStagedHome } from "../../shared/local-db-guard.js";
import { shq, buildSshSpawnArgs, sendWakeOnLan, FACTS_SCRIPT, FARM_SCRIPT, REMOTE_KILL_SCRIPT, buildTrustSeedCommand, trustSeedKey, runLocalWakeCommand, requireRemoteEngineBin, assertRemoteVersion, remoteSessionHome, remoteSessionBinDir, remoteEnginePidFile, buildSessionEnvFile } from "../remote-stage.js";
import { spawn } from "node:child_process";
import { remotePiExtensionSource } from "../pi-mcp.js";
import { JINN_HOME } from "../../shared/paths.js";
import { productBanner } from "../../shared/brand.js";

const isWindows = process.platform === "win32";

// ── shq ──────────────────────────────────────────────────────────────────────

/** Round-trip a value through a REAL POSIX shell and return what it received. */
function throughRealSh(value: string): Buffer {
  return execFileSync("sh", ["-c", `printf %s ${shq(value)}`]);
}

describe.skipIf(isWindows)("shq — real `sh -c` round trip", () => {
  const nasty = [
    ["single quotes", `it's a 'quoted' word`],
    ["spaces", "two  spaced   words"],
    ["dollar and expansion", `$HOME $(id) ${"${PATH}"}`],
    ["backticks", "`id`"],
    ["newline", "line one\nline two"],
    ["all of it", `a'b c$d\`e\`f\n$(touch g) "h" \\i`],
    ["backslashes", "a\\b\\\\c"],
    ["semicolons and redirects", "a; b | c > d & e"],
    ["empty string", ""],
    ["a lone quote", "'"],
    ["glob characters", "* ? [a-z] ~"],
    ["unicode", "héllo — ünicode ✅"],
  ] as const;

  for (const [label, value] of nasty) {
    it(`survives byte-identically: ${label}`, () => {
      expect(throughRealSh(value)).toEqual(Buffer.from(value, "utf8"));
    });
  }

  it("a value that would otherwise close the quote and run a command does not run it", () => {
    // If the escaping were broken this would resolve a command name; the canary
    // is deliberately a name nothing provides, so a break shows up as a throw
    // rather than as a side effect.
    const payload = `x'; jinn-injection-canary-9f3a; echo 'y`;
    expect(throughRealSh(payload)).toEqual(Buffer.from(payload, "utf8"));
  });
});

// ── buildSshSpawnArgs ────────────────────────────────────────────────────────

const REMOTE_CWD = "/srv/jinn-work/proj";

function build(over: Partial<Parameters<typeof buildSshSpawnArgs>[0]> = {}): string[] {
  return buildSshSpawnArgs({
    destination: "builder@build-box",
    tunnelPort: 44321,
    gatewayPort: 8722,
    remoteCwd: REMOTE_CWD,
    remoteEnv: {
      JINN_HOME: "/mnt/jinn-home/.jinn-remote-stage",
      JINN_SESSION_ID: "sess-1",
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
    },
    unsetRemoteEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"],
    bin: "/usr/local/bin/claude",
    args: ["--chrome", "--settings", "/mnt/jinn-home/.jinn-remote-stage/tmp/settings/sess-1.json"],
    ...over,
  });
}

/** The remote command is the last argv element, directly after the destination.
 *
 *  This helper used to assert a `--` immediately before it — and that assertion
 *  is the bug it should have caught. ssh consumes only the FIRST `--` it sees,
 *  so with the guard already placed before the destination, a second one reached
 *  the remote shell as `-- cd …` and every spawn died with
 *  `/bin/bash: --: invalid option`. See the argv invariant in
 *  claude-interactive-remote.test.ts, which now pins the shape properly. */
function remoteCommandOf(args: string[]): string {
  return args[args.length - 1];
}

/** Index-aware option lookup: `-o Foo=bar` is two argv elements. */
function hasOption(args: string[], value: string): boolean {
  return args.some((a, i) => a === "-o" && args[i + 1] === value);
}

describe("buildSshSpawnArgs — ssh flags", () => {
  const args = build();

  it("forces remote PTY allocation with -tt", () => {
    // An explicit remote command makes ssh default to NO pty, which breaks the
    // TUI and with it the viewport parser that answers safety prompts.
    expect(args).toContain("-tt");
  });

  it("is key-only (BatchMode=yes) — there is nobody at the keyboard", () => {
    expect(hasOption(args, "BatchMode=yes")).toBe(true);
  });

  it("disables ssh's own ~ escapes so transcript/paste content cannot fire them", () => {
    expect(hasOption(args, "EscapeChar=none")).toBe(true);
  });

  it("exits immediately when the reverse tunnel cannot be established", () => {
    // Otherwise the session runs with hooks and MCP calls that can never reach
    // the gateway — a silent permanent hang instead of a fast, settleable exit.
    expect(hasOption(args, "ExitOnForwardFailure=yes")).toBe(true);
  });

  it("forwards the gateway port back over the tunnel, bound to loopback", () => {
    const i = args.indexOf("-R");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("44321:127.0.0.1:8722");
  });

  // ssh consumes only the FIRST `--` it sees and passes any later one into the
  // remote command, so the terminator goes BEFORE the destination and the
  // command follows it directly. A second `--` here was what made every spawn
  // die with `/bin/bash: --: invalid option`.
  it("puts the one `--` before the destination, with the command straight after", () => {
    expect(args.filter((a) => a === "--")).toHaveLength(1);
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("builder@build-box"));
    expect(args[args.length - 2]).toBe("builder@build-box");
    expect(args[args.length - 1]).toMatch(/^cd '/);
  });

  it("carries keepalives so a dead link is noticed rather than hung on", () => {
    expect(hasOption(args, "ServerAliveInterval=30")).toBe(true);
    expect(hasOption(args, "ServerAliveCountMax=3")).toBe(true);
  });
});

describe("buildSshSpawnArgs — tunnel and forwards (opencode server mode)", () => {
  it("leaves the reverse tunnel on unless asked, so every existing caller is unchanged", () => {
    expect(build()).toEqual(build({ reverseTunnel: true }));
    expect(build()).toEqual(build({ localForwards: [] }));
  });

  it("drops the reverse tunnel for a connection that must not hold it", () => {
    // A second ssh binding the same -R port exits at once under
    // ExitOnForwardFailure, so only the server's connection may carry it.
    const args = build({ reverseTunnel: false });
    expect(args).not.toContain("-R");
    expect(args.join(" ")).not.toContain("44321:");
  });

  it("adds -L forwards bound to the gateway's loopback only", () => {
    const args = build({ localForwards: [{ localPort: 51000, remotePort: 47001 }] });
    const i = args.indexOf("-L");
    expect(args[i + 1]).toBe("127.0.0.1:51000:127.0.0.1:47001");
    // Still before the `--` and the destination, where ssh reads options.
    expect(i).toBeLessThan(args.indexOf("--"));
  });
});

describe("buildSshSpawnArgs — the remote command", () => {
  const cmd = remoteCommandOf(build());

  it("cds to the remoteCwd before anything else", () => {
    expect(cmd.startsWith(`cd ${shq(REMOTE_CWD)} &&`)).toBe(true);
  });

  it("execs env so the remote shell is replaced rather than kept in the middle", () => {
    expect(cmd).toContain("&& exec env ");
  });

  it("unsets the three billing-relevant Anthropic variables", () => {
    // An ANTHROPIC_API_KEY in the remote user's shell profile would flip the
    // session from Max-subscription auth to metered API billing, silently.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      expect(cmd).toContain(`'-u' '${key}'`);
    }
  });

  it("sets JINN_HOME and JINN_SESSION_ID for the remote process", () => {
    expect(cmd).toContain(`JINN_HOME='/mnt/jinn-home/.jinn-remote-stage'`);
    expect(cmd).toContain(`JINN_SESSION_ID='sess-1'`);
  });

  it("does NOT set ANTHROPIC_BASE_URL or the first-party assume flag — no SSE proxy runs remotely", () => {
    expect(cmd).not.toMatch(/ANTHROPIC_BASE_URL=/);
    expect(cmd).not.toMatch(/_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL/);
  });

  it("ends with the claude binary and its arguments", () => {
    expect(cmd).toContain(`'/usr/local/bin/claude' '--chrome' '--settings'`);
  });

  it("omits the env -u clause entirely when nothing is denied", () => {
    const bare = remoteCommandOf(build({ unsetRemoteEnv: [] }));
    expect(bare).toContain("&& exec env JINN_HOME=");
    expect(bare).not.toContain("'-u'");
  });
});

describe.skipIf(isWindows)("buildSshSpawnArgs — the remote command parsed by a REAL shell", () => {
  /**
   * Parse the remote command the way the remote login shell would, without
   * running anything: `env` is shadowed by a function that prints its argv, and
   * PATH is emptied so a quoting break can resolve no external command at all.
   */
  function remoteArgv(cmd: string, cwd: string): string[] {
    const script = [
      `PATH=''`,
      `env() { printf '%s\\0' "$@"; }`,
      cmd.replace(" && exec env ", " && env "),
    ].join("\n");
    const out = execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });
    const parts = out.split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-stage-"));
  });

  it("a prompt full of shell metacharacters arrives as ONE argument", () => {
    const prompt = `'; rm -rf /; echo '`;
    const cmd = remoteCommandOf(build({
      remoteCwd: dir,
      args: ["--chrome", prompt],
      unsetRemoteEnv: ["ANTHROPIC_API_KEY"],
    }));
    const argv = remoteArgv(cmd, dir);
    // Everything the remote `env` receives, in order.
    expect(argv).toEqual([
      "-u", "ANTHROPIC_API_KEY",
      "JINN_HOME=/mnt/jinn-home/.jinn-remote-stage",
      "JINN_SESSION_ID=sess-1",
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
      "/usr/local/bin/claude",
      "--chrome",
      prompt,
    ]);
    // The dangerous substring is one opaque argument, not a command.
    expect(argv.filter((a) => a.includes("rm -rf /"))).toEqual([prompt]);
  });

  it("a multi-line prompt with expansions and backticks survives intact", () => {
    const prompt = "line one $(id)\nline two `whoami` ${HOME} & echo done";
    const cmd = remoteCommandOf(build({
      remoteCwd: dir,
      args: ["-p", prompt],
      unsetRemoteEnv: [],
    }));
    const argv = remoteArgv(cmd, dir);
    expect(argv[argv.length - 1]).toBe(prompt);
    expect(argv[argv.length - 2]).toBe("-p");
  });

  it("an env VALUE containing a quote does not break the assignment", () => {
    const cmd = remoteCommandOf(build({
      remoteCwd: dir,
      remoteEnv: { JINN_SESSION_ID: `s'; id; echo '1` },
      unsetRemoteEnv: [],
      args: [],
    }));
    const argv = remoteArgv(cmd, dir);
    expect(argv).toEqual([`JINN_SESSION_ID=s'; id; echo '1`, "/usr/local/bin/claude"]);
  });

  it("the `cd` really lands in the remoteCwd", () => {
    const cmd = remoteCommandOf(build({ remoteCwd: dir, unsetRemoteEnv: [], args: [] }));
    const script = [
      `PATH=''`,
      `env() { printf '%s\\0' "$PWD"; }`,
      cmd.replace(" && exec env ", " && env "),
    ].join("\n");
    const pwd = execFileSync("sh", ["-c", script], { cwd: os.tmpdir(), encoding: "utf8" }).replace(/\0$/, "");
    expect(fs.realpathSync(pwd)).toBe(fs.realpathSync(dir));
  });
});

// ── sendWakeOnLan ────────────────────────────────────────────────────────────

describe("sendWakeOnLan — magic packet construction", () => {
  beforeEach(() => {
    sent.length = 0;
    broadcastSet = false;
    closed = false;
  });

  it("sends 102 bytes: 6 × 0xFF then the MAC sixteen times", async () => {
    await sendWakeOnLan("aa:bb:cc:dd:ee:ff");
    expect(sent).toHaveLength(1);
    const { buffer, length } = sent[0];
    expect(buffer).toHaveLength(102);
    expect(length).toBe(102);
    expect([...buffer.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const mac = Buffer.from("aabbccddeeff", "hex");
    for (let i = 0; i < 16; i += 1) {
      expect(buffer.subarray(6 + i * 6, 12 + i * 6), `repetition ${i}`).toEqual(mac);
    }
  });

  it("broadcasts to the discard port and closes the socket", async () => {
    await sendWakeOnLan("aa-bb-cc-dd-ee-ff");
    expect(broadcastSet).toBe(true);
    expect(sent[0].port).toBe(9);
    expect(sent[0].address).toBe("255.255.255.255");
    expect(sent[0].offset).toBe(0);
    expect(closed).toBe(true);
  });

  it("accepts the common MAC separators and bare hex identically", async () => {
    for (const mac of ["aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabbccddeeff", "aabb.ccdd.eeff"]) {
      sent.length = 0;
      await sendWakeOnLan(mac);
      expect(sent[0].buffer.subarray(6, 12), mac).toEqual(Buffer.from("aabbccddeeff", "hex"));
    }
  });

  it("throws on a malformed MAC rather than broadcasting a garbage packet", async () => {
    for (const bad of ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "not-a-mac", "zz:zz:zz:zz:zz:zz"]) {
      await expect(sendWakeOnLan(bad), bad).rejects.toThrow(/is not a 6-byte MAC address/);
    }
    expect(sent).toHaveLength(0);
  });
});

/**
 * The host-facts probe, run through a REAL POSIX shell against a fake nvm
 * layout. These are shell semantics, not TypeScript, and the bug they guard was
 * found on a live Raspberry Pi: a non-interactive ssh reads no rc file, so a
 * version-managed node is invisible and every hook would fail to start.
 */
describe.skipIf(process.platform === "win32")("FACTS_SCRIPT node resolution", () => {
  let home: string;

  /** A PATH with the utilities FACTS_SCRIPT shells out to but no `node`.
   *
   *  The probe only reaches for nvm when `node` is absent from PATH, so the
   *  fixture must guarantee that. `/usr/bin:/bin` does not: plenty of hosts
   *  carry a system node there, and the probe would report it and never take
   *  the version-managed path these tests are about. Symlinking the handful of
   *  tools the script needs keeps the test hermetic without inventing a shell.
   */
  function withoutNode(): string {
    const dir = path.join(home, "coreutils");
    fs.mkdirSync(dir, { recursive: true });
    // `sh` is here for Node's own lookup, not the script's: execFileSync
    // resolves the executable against the PATH it is handed.
    for (const tool of ["sh", "cat", "ls", "sort", "tail"]) {
      const link = path.join(dir, tool);
      const src = ["/bin", "/usr/bin"].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
      if (src && !fs.existsSync(link)) fs.symlinkSync(src, link);
    }
    return dir;
  }

  function runFacts(extraPath = ""): Record<string, string> {
    const out = execFileSync("sh", ["-s"], {
      input: FACTS_SCRIPT,
      encoding: "utf8",
      env: { HOME: home, PATH: extraPath || withoutNode() },
    });
    const kv: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return kv;
  }

  function fakeNode(version: string): void {
    const dir = path.join(home, ".nvm", "versions", "node", version, "bin");
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "node");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-facts-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reports $HOME even when nothing else is installed", () => {
    expect(runFacts().home).toBe(home);
  });

  it("finds a version-managed node that a non-interactive shell cannot see", () => {
    fakeNode("v22.22.3");
    // No nvm.sh is created on purpose: it is bash-only and /bin/sh is dash on
    // Debian-family systems, so sourcing it is not an option the script has.
    expect(runFacts().node).toBe(path.join(home, ".nvm/versions/node/v22.22.3/bin/node"));
  });

  it("honours nvm's default alias rather than taking the newest version", () => {
    fakeNode("v22.22.3");
    fakeNode("v24.14.1");
    fs.mkdirSync(path.join(home, ".nvm", "alias"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nvm", "alias", "default"), "22\n");
    // This is the case that matters: a global jinn-cli lives under ONE version's
    // tree, so resolving to v24 here would report jinn missing on a host where
    // it is installed perfectly well under v22.
    expect(runFacts().node).toContain("v22.22.3");
    expect(runFacts().node).not.toContain("v24");
  });

  it("falls back to the newest version when no default alias is set", () => {
    fakeNode("v22.22.3");
    fakeNode("v24.14.1");
    expect(runFacts().node).toContain("v24.14.1");
  });

  it("reports whichever agent CLIs the host has, without requiring either", () => {
    // A host that runs only Pi employees has no reason to carry Claude Code —
    // and the reverse. The probe reports what it finds; which of them is
    // REQUIRED is a per-engine question, asked by requireRemoteEngineBin.
    fakeNode("v22.22.3");
    const binDir = path.join(home, "sysbin");
    fs.mkdirSync(binDir, { recursive: true });
    const pi = path.join(binDir, "pi");
    fs.writeFileSync(pi, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(pi, 0o755);

    const opencode = path.join(binDir, "opencode");
    fs.writeFileSync(opencode, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(opencode, 0o755);

    const kv = runFacts(`${binDir}:/usr/bin:/bin`);
    expect(kv.pi).toBe(pi);
    expect(kv.opencode).toBe(opencode);
    expect(kv.claude).toBe("");
  });

  it("captures the first line of `jinn --version` as the gate will see it", () => {
    fakeNode("v22.22.3");
    const binDir = path.join(home, "sysbin");
    fs.mkdirSync(binDir, { recursive: true });
    const jinn = path.join(binDir, "jinn");
    fs.writeFileSync(jinn, `#!/bin/sh\nprintf '%s\\r\\nsecond line\\n' '${productBanner("0.33.3")}'\n`);
    fs.chmodSync(jinn, 0o755);

    const reported = runFacts(`${binDir}:/usr/bin:/bin`).jinnversion;
    expect(reported).toBe("Marid 0.33.3 (built on Jinn)");
    expect(assertRemoteVersion("build-box", reported, "0.33.3")).toBe("0.33.3");
  });

  it("prefers a node already on PATH over anything under nvm", () => {
    fakeNode("v22.22.3");
    const realDir = path.join(home, "sysbin");
    fs.mkdirSync(realDir, { recursive: true });
    const bin = path.join(realDir, "node");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    expect(runFacts(`${realDir}:/usr/bin:/bin`).node).toBe(bin);
  });
});

describe("buildSshSpawnArgs — remote PATH", () => {
  const base = {
    destination: "builder@build-box",
    tunnelPort: 40001,
    gatewayPort: 7777,
    remoteCwd: "/srv/jinn-work/main",
    remoteEnv: { JINN_HOME: "/home/u/.jinn-remote-stage" },
    bin: "/usr/bin/claude",
    args: ["--chrome"],
  };

  it("prepends the node directory so Claude Code's bare `node` hooks can run", () => {
    const cmd = buildSshSpawnArgs({
      ...base,
      pathPrepend: ["/home/u/.nvm/versions/node/v22.22.3/bin"],
    }).at(-1)!;
    expect(cmd).toContain(`PATH='/home/u/.nvm/versions/node/v22.22.3/bin':"$PATH"`);
  });

  it("leaves PATH untouched when nothing is prepended", () => {
    expect(buildSshSpawnArgs(base).at(-1)!).not.toContain("PATH=");
  });

  it.skipIf(process.platform === "win32")("expands to the host's own PATH, not a replacement", () => {
    const cmd = buildSshSpawnArgs({ ...base, pathPrepend: ["/opt/node/bin"] }).at(-1)!;
    // Pull out just the PATH assignment and let a real shell evaluate it.
    const assignment = cmd.match(/PATH=[^ ]+/)![0];
    const shown = execFileSync("sh", ["-c", `${assignment} sh -c 'printf %s "$PATH"'`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(shown).toBe("/opt/node/bin:/usr/bin:/bin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(isWindows)("FARM_SCRIPT — run for real against a fixture mount", () => {
  let dir: string;
  let mount: string;
  let root: string;

  /** Run the farm exactly as `sshScript` would: script on stdin to `sh -s`. */
  function runFarm(sessionId: string, ttlDays = 7): string {
    const home = path.join(root, "sessions", sessionId);
    return execFileSync("sh", ["-s", mount, root, home, String(ttlDays)], {
      input: FARM_SCRIPT,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-farm-"));
    mount = path.join(dir, "mount");
    root = path.join(dir, "stage");
    // A gateway instance home as the remote host sees it through sshfs.
    fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(mount, "org"), { recursive: true });
    fs.mkdirSync(path.join(mount, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(mount, "knowledge", "a.md"), "real knowledge\n");
    fs.writeFileSync(path.join(mount, "gateway.json"), '{"port":7777}\n');
    // The gateway copies the relay INTO its own home, so the mount exposes it.
    fs.writeFileSync(path.join(mount, "hook-relay.mjs"), "// the gateway's copy\n");
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("gives each session its own JINN_HOME, so one spawn cannot repoint another", () => {
    runFarm("sess-a");
    runFarm("sess-b");
    const a = path.join(root, "sessions", "sess-a");
    const b = path.join(root, "sessions", "sess-b");
    // The whole point: gateway.json names a PER-SPAWN tunnel port, so a shared
    // home would let one session's prepare rewrite the port another live turn's
    // hook relay is about to read — and the relay swallows a failed POST, so
    // that turn completes with no Stop and nothing reported anywhere.
    expect(fs.existsSync(path.join(a, "knowledge"))).toBe(true);
    expect(fs.existsSync(path.join(b, "knowledge"))).toBe(true);
    fs.writeFileSync(path.join(a, "gateway.json"), '{"port":1111}\n');
    fs.writeFileSync(path.join(b, "gateway.json"), '{"port":2222}\n');
    expect(fs.readFileSync(path.join(a, "gateway.json"), "utf8")).toContain("1111");
    expect(fs.readFileSync(path.join(b, "gateway.json"), "utf8")).toContain("2222");
  });

  it("writes through the farm to the real gateway home", () => {
    runFarm("sess-a");
    fs.writeFileSync(path.join(root, "sessions", "sess-a", "knowledge", "b.md"), "written from the remote\n");
    // The single operation the whole mount exists to permit.
    expect(fs.readFileSync(path.join(mount, "knowledge", "b.md"), "utf8")).toBe("written from the remote\n");
  });

  it("never symlinks gateway.json or tmp/ — both are real, host-local", () => {
    runFarm("sess-a");
    const home = path.join(root, "sessions", "sess-a");
    expect(fs.existsSync(path.join(home, "gateway.json"))).toBe(false);
    expect(fs.lstatSync(path.join(home, "tmp")).isSymbolicLink()).toBe(false);
  });

  it("leaves the REAL hook-relay.mjs alone across repeated spawns", () => {
    // The regression: the relay lives at the stage ROOT, outside every
    // session's farm. When it sat inside the farm, `ln -sfn` on the second
    // spawn replaced the real copy with a symlink into the mount — so a mount
    // blip would take the relay, and with it every Stop hook, hanging the turn.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "// the staged real copy\n");
    for (let i = 0; i < 3; i += 1) runFarm("sess-a");
    const relay = path.join(root, "hook-relay.mjs");
    expect(fs.lstatSync(relay).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(relay, "utf8")).toBe("// the staged real copy\n");
  });

  it("reports which per-host assets are really present, so a wiped stage restages", () => {
    fs.mkdirSync(root, { recursive: true });
    expect(runFarm("sess-a")).not.toContain("asset=hook-relay.mjs");

    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "// real\n");
    fs.writeFileSync(path.join(root, "remote-trust-seed.mjs"), "// real\n");
    const out = runFarm("sess-a");
    expect(out).toContain("asset=hook-relay.mjs");
    expect(out).toContain("asset=remote-trust-seed.mjs");

    // A symlink is NOT a real copy — reporting one as present is exactly what
    // would put the relay back on the mount for the hook hot path.
    fs.unlinkSync(path.join(root, "hook-relay.mjs"));
    fs.symlinkSync(path.join(mount, "hook-relay.mjs"), path.join(root, "hook-relay.mjs"));
    expect(runFarm("sess-a")).not.toContain("asset=hook-relay.mjs");
  });

  it("prunes stale symlinks when the gateway home loses a directory", () => {
    runFarm("sess-a");
    const home = path.join(root, "sessions", "sess-a");
    expect(fs.existsSync(path.join(home, "org"))).toBe(true);
    fs.rmSync(path.join(mount, "org"), { recursive: true });
    runFarm("sess-a");
    expect(fs.existsSync(path.join(home, "org"))).toBe(false);
    expect(fs.lstatSync(path.join(home, "knowledge")).isSymbolicLink()).toBe(true);
  });

  describe("the gateway's SQLite databases", () => {
    /** The gateway's sessions/ and workflows/, as the mount exposes them. */
    function seedDatabases(): void {
      const sessions = path.join(mount, "sessions");
      fs.mkdirSync(path.join(sessions, "backups"), { recursive: true });
      fs.mkdirSync(path.join(sessions, "sess-x", "pi-session"), { recursive: true });
      const live = new Database(path.join(sessions, "registry.db"));
      live.pragma("journal_mode = WAL");
      live.exec("create table t(x); insert into t values (1)");
      live.close();
      fs.writeFileSync(path.join(sessions, "registry.db-wal"), "");
      fs.writeFileSync(path.join(sessions, "registry.db-shm"), "");
      fs.writeFileSync(path.join(sessions, "registry.db.version"), "0.33.3\n");
      fs.writeFileSync(path.join(sessions, "restart-interrupted.jsonl"), "{}\n");
      fs.writeFileSync(path.join(sessions, "backups", "registry.db.pre-x"), "snapshot");
      fs.mkdirSync(path.join(mount, "workflows"));
      fs.writeFileSync(path.join(mount, "workflows", "workflows.db"), "");
      fs.writeFileSync(path.join(mount, "workflows", "workflows.db-wal"), "");
    }
    const homeOf = (id: string) => path.join(root, "sessions", id);

    it("stages sessions/ as a real directory that links everything except the databases", () => {
      seedDatabases();
      runFarm("sess-a");
      const sessions = path.join(homeOf("sess-a"), "sessions");
      expect(fs.lstatSync(sessions).isDirectory()).toBe(true);
      expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(false);
      for (const name of ["registry.db.version", "restart-interrupted.jsonl", "sess-x"]) {
        expect(fs.lstatSync(path.join(sessions, name)).isSymbolicLink()).toBe(true);
      }
      for (const name of ["registry.db-wal", "registry.db-shm", "backups"]) {
        expect(fs.existsSync(path.join(sessions, name))).toBe(false);
      }
      // Each database is a directory, so it cannot be opened from here.
      expect(fs.lstatSync(path.join(sessions, "registry.db")).isDirectory()).toBe(true);
      const workflows = path.join(homeOf("sess-a"), "workflows");
      expect(fs.lstatSync(workflows).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(path.join(workflows, "workflows.db")).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(workflows, "workflows.db-wal"))).toBe(false);
    });

    it("writes to linked entries still reach the gateway", () => {
      seedDatabases();
      runFarm("sess-a");
      fs.appendFileSync(path.join(homeOf("sess-a"), "sessions", "restart-interrupted.jsonl"), "{\"x\":1}\n");
      expect(fs.readFileSync(path.join(mount, "sessions", "restart-interrupted.jsonl"), "utf8")).toContain("\"x\":1");
    });

    it("makes a stray open fail instead of creating an empty local database, and touches nothing on the gateway", () => {
      seedDatabases();
      runFarm("sess-a");
      const staged = path.join(homeOf("sess-a"), "sessions", "registry.db");
      const before = fs.readdirSync(path.join(mount, "sessions")).sort();
      expect(() => new Database(staged)).toThrow();
      expect(() => new Database(staged, { readonly: true })).toThrow();
      expect(fs.lstatSync(staged).isDirectory()).toBe(true);
      expect(fs.readdirSync(staged)).toEqual([]);
      expect(fs.readdirSync(path.join(mount, "sessions")).sort()).toEqual(before);
    });

    it("migrates a stage that linked sessions/ whole", () => {
      seedDatabases();
      const home = homeOf("sess-a");
      fs.mkdirSync(home, { recursive: true });
      fs.symlinkSync(path.join(mount, "sessions"), path.join(home, "sessions"));
      runFarm("sess-a");
      expect(fs.lstatSync(path.join(home, "sessions")).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(path.join(home, "sessions", "registry.db")).isDirectory()).toBe(true);
      // The gateway's real directory was not touched through the old link.
      expect(fs.lstatSync(path.join(mount, "sessions", "registry.db")).isFile()).toBe(true);
    });

    it("prunes child links the gateway no longer has, and clears real database files left in the stage", () => {
      seedDatabases();
      runFarm("sess-a");
      const sessions = path.join(homeOf("sess-a"), "sessions");
      fs.rmSync(path.join(mount, "sessions", "sess-x"), { recursive: true });
      fs.writeFileSync(path.join(sessions, "registry.db-wal"), "stray");
      fs.writeFileSync(path.join(sessions, "other.db"), "stray");
      runFarm("sess-a");
      expect(fs.existsSync(path.join(sessions, "sess-x"))).toBe(false);
      expect(fs.existsSync(path.join(sessions, "registry.db-wal"))).toBe(false);
      expect(fs.existsSync(path.join(sessions, "other.db"))).toBe(false);
      expect(fs.lstatSync(path.join(sessions, "restart-interrupted.jsonl")).isSymbolicLink()).toBe(true);
    });

    it("replaces a real database file left at a database name with the directory sentinel", () => {
      seedDatabases();
      runFarm("sess-a");
      const staged = path.join(homeOf("sess-a"), "sessions", "registry.db");
      fs.rmdirSync(staged);
      fs.writeFileSync(staged, "");
      runFarm("sess-a");
      expect(fs.lstatSync(staged).isDirectory()).toBe(true);
    });

    it("does not invent a workflows/ the gateway does not have", () => {
      runFarm("sess-a");
      expect(fs.existsSync(path.join(homeOf("sess-a"), "workflows"))).toBe(false);
      expect(fs.existsSync(path.join(homeOf("sess-a"), "sessions"))).toBe(false);
    });

    it("survives concurrent rebuilds of the same session (no mkdir race under set -eu)", async () => {
      seedDatabases();
      const home = homeOf("sess-a");
      const once = () => new Promise<number>((resolve) => {
        const child = spawn("sh", ["-s", mount, root, home, "7"]);
        child.stdin.end(FARM_SCRIPT);
        child.on("close", (code) => resolve(code ?? 1));
      });
      const codes = await Promise.all(Array.from({ length: 40 }, once));
      expect(codes.filter((code) => code !== 0)).toEqual([]);
      expect(fs.lstatSync(path.join(home, "sessions", "registry.db")).isDirectory()).toBe(true);
    }, 30000);

    it("marks the stage with a real marker file, never a link from the mount", () => {
      fs.writeFileSync(path.join(mount, REMOTE_STAGE_MARKER), "should not be linked");
      runFarm("sess-a");
      const marker = path.join(homeOf("sess-a"), REMOTE_STAGE_MARKER);
      expect(fs.lstatSync(marker).isFile()).toBe(true);
      expect(fs.readFileSync(marker, "utf8")).toContain("remote session stage");
      expect(isRemoteStagedHome(homeOf("sess-a"))).toBe(true);
    });
  });

  it("reaps dead session stages but never the one being prepared", () => {
    runFarm("old-sess");
    runFarm("live-sess");
    const old = path.join(root, "sessions", "old-sess");
    const ago = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(old, ago, ago);
    runFarm("live-sess");
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(root, "sessions", "live-sess"))).toBe(true);
  });

  it("is idempotent and keeps the stage private", () => {
    runFarm("sess-a");
    const before = fs.readdirSync(path.join(root, "sessions", "sess-a")).sort();
    runFarm("sess-a");
    expect(fs.readdirSync(path.join(root, "sessions", "sess-a")).sort()).toEqual(before);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, "sessions", "sess-a")).mode & 0o777).toBe(0o700);
  });
});

describe("buildSshSpawnArgs — the destination is never read as an option", () => {
  it("puts `--` before the destination", () => {
    // Verified against the real ssh: WITHOUT this, `-oProxyCommand=…` as a host
    // is interpreted by the LOCAL ssh and the command runs ON THE GATEWAY.
    // Employees are explicitly told they may hand-edit org YAML, so this is a
    // reachable jump from "can edit a roster file" to gateway code execution.
    const args = build({ destination: "builder@build-box" });
    const at = args.indexOf("builder@build-box");
    expect(at).toBeGreaterThan(-1);
    expect(args[at - 1]).toBe("--");
  });

  it("keeps the remote command as the final argument after its own `--`", () => {
    expect(remoteCommandOf(build())).toContain("exec env");
  });
});

describe.skipIf(isWindows)("buildSshSpawnArgs — the session secret file", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-envfile-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("sources the env file, and keeps the token OUT of the command line", () => {
    const envFile = path.join(dir, "session-env.sh");
    const cmd = remoteCommandOf(build({ envFile }));
    expect(cmd).toContain(`. '${envFile}'`);
    // A remote command line is readable by every process on that host through
    // the process table, so the bearer must never be inlined into it.
    expect(cmd).not.toContain("secret-bearer-token");
  });

  it("the sourced values actually reach the exec'd process", () => {
    const envFile = path.join(dir, "session-env.sh");
    fs.writeFileSync(envFile, [
      `export JINN_GATEWAY_URL='http://127.0.0.1:44321'`,
      `export JINN_GATEWAY_TOKEN='secret-bearer-token'`,
      "",
    ].join("\n"));
    // A real executable, not a shell function: `env` execs a binary, so a
    // function would be invisible to it.
    const fakeClaude = path.join(dir, "fake-claude");
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf "%s|%s" "$JINN_GATEWAY_URL" "$JINN_GATEWAY_TOKEN"\n', { mode: 0o755 });
    const cmd = remoteCommandOf(build({ envFile, remoteCwd: dir, bin: fakeClaude, args: [] }));
    // Run it for real. This is the claim that matters: the system prompt tells
    // every session both vars are already exported, and every documented curl —
    // delegation included — is dead if that is not true.
    const out = execFileSync("sh", ["-c", cmd.replace("exec env", "env")], { cwd: dir, encoding: "utf8" });
    expect(out).toBe("http://127.0.0.1:44321|secret-bearer-token");
  });
});

/**
 * A session that changes engine mid-flight must not change another engine's
 * staged home underneath it.
 *
 * The concrete failure: a rate-limited Claude session is substituted onto pi
 * WITHOUT its PTY being released, so that PTY stays warm and takes the next turn
 * with no re-staging — while its hook relay re-reads `gateway.json` on every
 * hook. One shared home means pi's prepare rewrote the port behind it, and the
 * relay then POSTs into a tunnel that died with pi's ssh. The relay swallows a
 * failed POST by design, so the turn runs to completion with no Stop and nothing
 * reported anywhere.
 */
describe("remoteSessionHome — per session AND per engine", () => {
  const FACTS = {
    home: "/home/u",
    stageDir: "/home/u/.jinn-remote-stage",
    nodeBin: "/usr/bin/node",
    jinnVersion: "0.32.0",
    entryDir: "/usr/lib/jinn/dist/src/mcp",
  };

  it("gives every engine on one session its own home", () => {
    const homes = REMOTE_ENGINE_NAMES.map((engine) => remoteSessionHome(FACTS, "sess-1", engine));
    // …and therefore its own gateway.json, which is the whole point: a session
    // substituted onto another engine must not restage the home the engine it
    // came from is still reading out of.
    expect(new Set(homes).size).toBe(REMOTE_ENGINE_NAMES.length);
    expect(new Set(homes.map((h) => path.posix.dirname(h))).size).toBe(1);
  });

  it("keeps each home a single directory under sessions/, where the reaper looks", () => {
    // FARM_SCRIPT reaps with `-mindepth 1 -maxdepth 1 -type d -mtime`. A nested
    // <session>/<engine> layout would hide a live session's mtime behind a
    // parent directory no spawn ever touches, and the reaper would delete a
    // session that is still running.
    const home = remoteSessionHome(FACTS, "sess-1", "pi");
    const prefix = `${FACTS.stageDir}/sessions/`;
    expect(home.startsWith(prefix)).toBe(true);
    expect(home.slice(prefix.length)).not.toContain("/");
  });

  it("still cannot walk out of the sessions directory", () => {
    expect(remoteSessionHome(FACTS, "../../etc", "pi")).toBe(`${FACTS.stageDir}/sessions/.._.._etc__pi`);
  });

  it("puts the PATH's bin/ inside the home the spawn was actually given", () => {
    // The farm symlinks the mounted home's bin/ into EACH session home, so the
    // entry only exists under the home this spawn staged. Derived from that
    // home rather than re-derived from the session id, which under a per-engine
    // home is how the PATH ends up naming a farm nobody built.
    const home = remoteSessionHome(FACTS, "sess-1", "pi");
    expect(remoteSessionBinDir(home)).toBe(`${home}/bin`);
  });
});

/**
 * What goes in the 0600 file, and what is left on a command line every process
 * on the remote host can read.
 */
describe("buildSessionEnvFile", () => {
  it("keeps the bearer and the session capability out of argv", () => {
    // JINN_SESSION_CAPABILITY authorizes acting AS this session against the
    // gateway (mcp/identity.ts). Pi has no staged mcp.json to carry it the way
    // Claude does, so this file is its equivalent — putting it in `remoteEnv`
    // instead would inline it into the remote command, visible to `ps`.
    const content = buildSessionEnvFile(44321, "secret-bearer", {
      JINN_SESSION_ID: "sess-1",
      JINN_SESSION_CAPABILITY: "cap-token",
    });
    expect(content).toContain("export JINN_GATEWAY_TOKEN='secret-bearer'");
    expect(content).toContain("export JINN_SESSION_CAPABILITY='cap-token'");
    expect(content).toContain("export JINN_GATEWAY_URL='http://127.0.0.1:44321'");
  });

  it("omits the bearer line entirely when the gateway has no token", () => {
    expect(buildSessionEnvFile(44321, undefined)).not.toContain("JINN_GATEWAY_TOKEN");
  });

  // Through a REAL shell, because the claim is about what the remote `sh`
  // makes of this file, not about what the string looks like here.
  it.skipIf(process.platform === "win32")("delivers a hostile value intact rather than executing it", () => {
    const hostile = "a'; touch /tmp/jinn-pwned; '";
    const fragment = buildSessionEnvFile(44321, undefined, { JINN_SESSION_CAPABILITY: hostile });
    const out = execFileSync("sh", ["-c", `${fragment}\nprintf '%s' "$JINN_SESSION_CAPABILITY"`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBe(hostile);
  });
});

/**
 * Which agent CLI a host must carry is a property of the ENGINE the session
 * runs, not of the host.
 *
 * Asserting it per host would make a desktop that runs Pi employees unusable
 * over a Claude Code install nothing on it was ever going to start — and facts
 * are cached per host and shared by every session on it, so the check has to
 * live where the engine is known.
 */
describe("requireRemoteEngineBin", () => {
  const FACTS = {
    home: "/home/u",
    stageDir: "/home/u/.jinn-remote-stage",
    nodeBin: "/usr/bin/node",
    piBin: "/usr/local/bin/pi",
    jinnVersion: "0.32.0",
    entryDir: "/usr/lib/jinn/dist/src/mcp",
  };

  it("returns the engine's own binary", () => {
    expect(requireRemoteEngineBin("build-box", FACTS, "pi")).toBe("/usr/local/bin/pi");
    expect(requireRemoteEngineBin("build-box", { ...FACTS, claudeBin: "/usr/local/bin/claude" }, "claude"))
      .toBe("/usr/local/bin/claude");
    expect(requireRemoteEngineBin("build-box", { ...FACTS, opencodeBin: "/usr/local/bin/opencode" }, "opencode"))
      .toBe("/usr/local/bin/opencode");
  });

  it("does not refuse a Pi host for having no Claude Code or opencode on it", () => {
    expect(() => requireRemoteEngineBin("build-box", FACTS, "pi")).not.toThrow();
  });

  it("names the missing binary for every engine that can run remotely", () => {
    // The map from engine to facts field is the thing under test: a fourth
    // engine wired into one reader and not the other would report a host as
    // having nothing installed on it.
    for (const engine of REMOTE_ENGINE_NAMES) {
      if (engine === "pi") continue;
      expect(() => requireRemoteEngineBin("build-box", FACTS, engine))
        .toThrow(new RegExp(`build-box has no \\\`${engine}\\\``));
    }
  });

  it("names the host, the binary and how to check the PATH when one is missing", () => {
    // A non-interactive ssh reads no rc file, so "not installed" is the wrong
    // diagnosis far more often than it is the right one — the message has to
    // say how to tell the two apart.
    expect(() => requireRemoteEngineBin("build-box", FACTS, "claude"))
      .toThrow(/build-box has no `claude`.*command -v claude/s);
  });
});

/**
 * Pi loads the company toolset from a generated module rather than an
 * `--mcp-config`, and that module's imports are absolute paths.
 *
 * Staged verbatim they name the GATEWAY's dist — which is not on the other
 * machine and is not what the mount carries — so the remote copy has to be
 * regenerated against that host's own install.
 */
describe("remotePiExtensionSource", () => {
  const ENTRY_DIR = "/home/u/.nvm/versions/node/v22.22.3/lib/node_modules/jinn-cli/dist/src/mcp";
  const source = remotePiExtensionSource(ENTRY_DIR);

  it("imports the built-in server and the tool projection from the REMOTE install", () => {
    expect(source).toContain(`"file://${ENTRY_DIR}/server.js"`);
    expect(source).toContain(`"file:///home/u/.nvm/versions/node/v22.22.3/lib/node_modules/jinn-cli/dist/src/engines/pi-mcp.js"`);
  });

  it("names no path belonging to the gateway that generated it", () => {
    // The failure this guards is silent in the worst way: the extension simply
    // fails to import, and pi runs the turn with none of the company tools.
    expect(source).not.toContain(fileURLToPath(new URL("../pi-mcp.ts", import.meta.url)));
    expect(source).not.toContain(JINN_HOME);
  });

  it("registers the same tools the local extension does", () => {
    // Same generator, so the two cannot drift: only the two module URLs differ.
    expect(source).toContain("pi.registerTool");
    expect(source).toContain("notesEnabledFromConfig");
  });
});

/**
 * The folder-trust seed and the session must agree on which Claude Code profile
 * they are talking about.
 *
 * Claude Code keeps `.claude.json` INSIDE `CLAUDE_CONFIG_DIR`, so a seed run
 * without the variable writes `~/.claude.json` while a session with it reads
 * `<profile>/.claude.json`. The dialog then appears in front of a PTY with
 * nobody at the keyboard and the first turn hangs forever, reporting nothing —
 * indistinguishable from never having seeded at all.
 */
describe("trust seed — profile agreement", () => {
  const FACTS = {
    home: "/home/u",
    stageDir: "/home/u/.jinn-remote-stage",
    nodeBin: "/usr/bin/node",
    bin: "/usr/local/bin/claude",
    jinnVersion: "0.32.0",
    entryDir: "/usr/lib/jinn/src/mcp",
  };
  const PROFILE = "/home/u/.claude-profiles/personal";

  it("runs the seeder under the session's CLAUDE_CONFIG_DIR", () => {
    const cmd = buildTrustSeedCommand(FACTS, "/srv/jinn-work/proj", PROFILE);
    expect(cmd).toContain(`CLAUDE_CONFIG_DIR='${PROFILE}'`);
    // …and before the interpreter, so it is that process's environment.
    expect(cmd.indexOf("CLAUDE_CONFIG_DIR=")).toBeLessThan(cmd.indexOf("/usr/bin/node"));
  });

  it("sets no profile when none is configured, matching a default-profile session", () => {
    expect(buildTrustSeedCommand(FACTS, "/srv/jinn-work/proj", undefined)).not.toContain("CLAUDE_CONFIG_DIR");
  });

  // Run the real command through a real shell, with `node` shadowed by a
  // function that prints the variable. This proves the value reaches the
  // interpreter's ENVIRONMENT intact — not merely that it appears in the string.
  it.skipIf(process.platform === "win32")("delivers a profile path with quotes and spaces intact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-seed-"));
    try {
      const profile = "/home/u/profiles/it's here";
      const cmd = buildTrustSeedCommand({ ...FACTS, nodeBin: "node" }, dir, profile);
      const shown = execFileSync("sh", ["-c", `node() { printf %s "$CLAUDE_CONFIG_DIR"; }\n${cmd}`], {
        encoding: "utf8",
      });
      expect(shown).toBe(profile);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-seeds when the profile changes, because trust lives in the profile", () => {
    const a = trustSeedKey("box", "/srv/jinn-work/proj", PROFILE);
    const b = trustSeedKey("box", "/srv/jinn-work/proj", "/home/u/.claude-profiles/alt");
    const none = trustSeedKey("box", "/srv/jinn-work/proj", undefined);
    expect(new Set([a, b, none]).size).toBe(3);
  });

  it("does not re-seed the same profile and directory twice", () => {
    expect(trustSeedKey("box", "/srv/jinn-work/proj", PROFILE))
      .toBe(trustSeedKey("box", "/srv/jinn-work/proj", PROFILE));
  });
});


/**
 * The wake budget.
 *
 * A real startup path is not a packet: it may probe reachability, read a power
 * state over the network, press a physical ATX button, then wait for POST. The
 * dangerous kill is the one that lands BETWEEN the state read and the press —
 * the host never wakes and the turn just times out with nothing to show.
 */
describe("wakeCommand timeout", () => {
  // Driven directly rather than through ensureRemoteReady: that path spawns real
  // ssh probes, which are slow and can outlive the test as unhandled child
  // errors — a test that reddens CI at random is worse than no test.

  it("lets a command run well past the old thirty-second limit", async () => {
    const started = Date.now();
    await runLocalWakeCommand("sleep 0.3", 300_000);
    const elapsed = Date.now() - started;
    // Ran to completion rather than being cut short.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("still kills a command that overruns its budget", async () => {
    const started = Date.now();
    await runLocalWakeCommand("sleep 30", 300);
    // Without the kill this would take 30s.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 40_000);

  it("returns rather than throwing when the command cannot start", async () => {
    // A wake is best-effort: reachability is the real verdict, so a broken
    // command must not take the turn down with it.
    await expect(runLocalWakeCommand("definitely-not-a-real-binary-xyz", 5_000)).resolves.toBeUndefined();
  }, 20_000);
});
/**
 * The company's operating rules, where a remote session will actually look.
 *
 * A local employee gets CLAUDE.md free — its cwd IS the gateway home. A remote
 * session's cwd is the workspace, so without this the rules are simply absent
 * and the employee works with no knowledge of how the company operates.
 *
 * Run through a real shell against real directories: the value here is entirely
 * in the two guards, and a guard asserted only in the abstract is not a guard.
 */
describe.skipIf(process.platform === "win32")("FARM_SCRIPT — workspace CLAUDE.md", () => {
  let base: string;
  const run = (cwd: string): string => execFileSync("sh", ["-s", `${base}/mount`, `${base}/root`, `${base}/home`, "7", cwd], {
    input: FARM_SCRIPT,
    encoding: "utf8",
  });

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-farm-"));
    fs.mkdirSync(`${base}/mount`, { recursive: true });
    fs.writeFileSync(`${base}/mount/CLAUDE.md`, "COMPANY RULES\n");
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("links the rules into an empty workspace root", () => {
    const ws = `${base}/workspace`;
    expect(run(ws)).toContain("claudemd=linked");
    expect(fs.readFileSync(`${ws}/CLAUDE.md`, "utf8")).toBe("COMPANY RULES\n");
    expect(fs.lstatSync(`${ws}/CLAUDE.md`).isSymbolicLink()).toBe(true);
  });

  it("refuses to write into a git working tree", () => {
    // Repos live in SUBFOLDERS of the workspace. Dropping an untracked file into
    // a checkout would show up in git status and die to `git clean -fdx`.
    const repo = `${base}/repo`;
    fs.mkdirSync(`${repo}/.git`, { recursive: true });
    expect(run(repo)).toContain("claudemd=skipped");
    expect(fs.existsSync(`${repo}/CLAUDE.md`)).toBe(false);
  });

  it("never overwrites a real CLAUDE.md that is already there", () => {
    const dir = `${base}/own`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/CLAUDE.md`, "THEIR OWN RULES\n");
    expect(run(dir)).toContain("claudemd=skipped");
    expect(fs.readFileSync(`${dir}/CLAUDE.md`, "utf8")).toBe("THEIR OWN RULES\n");
  });

  it("restores the link if it is deleted, and is idempotent", () => {
    const ws = `${base}/workspace`;
    run(ws);
    run(ws);
    expect(fs.readFileSync(`${ws}/CLAUDE.md`, "utf8")).toBe("COMPANY RULES\n");
    fs.unlinkSync(`${ws}/CLAUDE.md`);
    run(ws);
    expect(fs.existsSync(`${ws}/CLAUDE.md`)).toBe(true);
  });

  it("does nothing when the gateway home has no CLAUDE.md", () => {
    fs.unlinkSync(`${base}/mount/CLAUDE.md`);
    const ws = `${base}/workspace`;
    expect(run(ws)).not.toContain("claudemd=");
    expect(fs.existsSync(`${ws}/CLAUDE.md`)).toBe(false);
  });
});

// ── the remote pid, and the kill that uses it ────────────────────────────────

describe("buildSshSpawnArgs — pidFile", () => {
  it("records nothing unless asked: the interactive engine's hangup already works", () => {
    expect(remoteCommandOf(build())).not.toContain("engine.pid");
    expect(remoteCommandOf(build())).not.toContain('"$$"');
  });

  it("names the file under the session's own tmp/, beside the env file", () => {
    expect(remoteEnginePidFile("/home/builder/.jinn-remote-stage/sessions/sess-1__opencode"))
      .toBe("/home/builder/.jinn-remote-stage/sessions/sess-1__opencode/tmp/engine.pid");
  });

  it("writes the pid AFTER the env file is sourced and BEFORE exec", () => {
    const cmd = remoteCommandOf(build({ envFile: "/stage/tmp/session-env.sh", pidFile: "/stage/tmp/engine.pid", allocateTty: false }));
    expect(cmd).toBe(
      `cd '${REMOTE_CWD}' && . '/stage/tmp/session-env.sh' && printf '%s\\n%s\\n' "$$" "$(ps -o lstart= -p $$ 2>/dev/null)" > '/stage/tmp/engine.pid' && exec env `
      + `'-u' 'ANTHROPIC_API_KEY' '-u' 'ANTHROPIC_AUTH_TOKEN' '-u' 'ANTHROPIC_BASE_URL' '-u' 'CLAUDECODE' `
      + `JINN_HOME='/mnt/jinn-home/.jinn-remote-stage' JINN_SESSION_ID='sess-1' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN='1' `
      + `'/usr/local/bin/claude' '--chrome' '--settings' '/mnt/jinn-home/.jinn-remote-stage/tmp/settings/sess-1.json'`,
    );
  });

  it.skipIf(isWindows)("through a REAL shell, the file holds the pid `exec` hands to the agent, and its start time", () => {
    // `env` is shadowed by a function that prints ITS pid — the exec'd agent's,
    // since a function runs in the shell that would have been replaced — and
    // the file must hold that same number, then the start time the real `ps`
    // reports for it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pidfile-"));
    const pidFile = path.join(dir, "engine.pid");
    const cmd = remoteCommandOf(build({ remoteCwd: dir, pidFile, unsetRemoteEnv: [], args: [] }));
    const script = [
      `env() { printf '%s\\n%s' "$$" "$(ps -o lstart= -p $$)"; }`,
      cmd.replace(" && exec env ", " && env "),
    ].join("\n");
    const [shellPid, started] = execFileSync("sh", ["-c", script], { cwd: dir, encoding: "utf8" }).split("\n");
    expect(shellPid).toMatch(/^[0-9]+$/);
    expect(started).toBeTruthy();
    expect(fs.readFileSync(pidFile, "utf8")).toBe(`${shellPid}\n${started}\n`);
  });
});

describe.skipIf(isWindows)("REMOTE_KILL_SCRIPT — run for real against a process tree", () => {
  let dir: string;
  let pidFile: string;

  /** Run the kill exactly as `sshScript` would: script on stdin to `sh -s`. */
  function runKill(ident: string, grace = 5): string {
    return execFileSync("sh", ["-s", pidFile, ident, String(grace)], { input: REMOTE_KILL_SCRIPT, encoding: "utf8" }).trim();
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Wait for a pid to exit; the kernel needs a moment after the signal lands. */
  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 40 && alive(pid); i += 1) await wait(50);
    return !alive(pid);
  }

  /** An agent-shaped tree: a session leader (as a no-tty sshd child is) whose
   *  own pid is in the file, with one child in the same group and one — like
   *  every bash-tool command opencode runs — in a session of its own. */
  async function spawnTree(agentScript: string): Promise<{ agent: number; children: number[] }> {
    const childPids = path.join(dir, "children");
    const proc = spawn("setsid", ["sh", "-c", `printf '%s\\n%s\\n' "$$" "$(ps -o lstart= -p $$)" > "$0"; ${agentScript}`, pidFile, childPids], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    for (let i = 0; i < 40 && !fs.existsSync(childPids); i += 1) await wait(50);
    await wait(100);
    const agent = Number(fs.readFileSync(pidFile, "utf8").split("\n")[0]);
    const children = fs.readFileSync(childPids, "utf8").trim().split("\n").map(Number);
    return { agent, children };
  }
  const TREE = `setsid sleep 300 & printf '%s\\n' "$!" >> "$1"; sleep 300 & printf '%s\\n' "$!" >> "$1"; exec sleep 300`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-kill-"));
    pidFile = path.join(dir, "engine.pid");
  });

  it("terminates the agent AND its descendants, including one in its own session", async () => {
    const { agent, children } = await spawnTree(TREE);
    expect(alive(agent)).toBe(true);
    expect(children).toHaveLength(2);

    expect(runKill("sleep")).toBe("terminated");

    expect(await gone(agent)).toBe(true);
    for (const child of children) expect(await gone(child)).toBe(true);
    // The file named a process that is now gone; left behind, an interrupt
    // arriving mid-spawn next turn would read it and believe the new agent
    // already dead.
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("knows the agent by its start time, not its argv", async () => {
    // A pnpm shim exec's `node …/cli.js`, so the binary's path never appears
    // in argv; the start time is what exec preserves and what the check uses.
    const { agent } = await spawnTree(TREE);
    expect(runKill("/a/path/that/is/not/in/argv")).toBe("terminated");
    expect(await gone(agent)).toBe(true);
  });

  it("refuses a live pid that matches neither the recorded start time nor the binary", async () => {
    const { agent } = await spawnTree(TREE);
    fs.writeFileSync(pidFile, `${agent}\nThu Jan  1 00:00:00 1970\n`);
    expect(runKill("/not/the/agent")).toBe("pid-reused");
    expect(alive(agent)).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
    process.kill(-agent, "SIGKILL");
  });

  it("still knows the agent by its binary when the start time no longer matches", async () => {
    // A clock step on the host (chrony makestep after a resume) moves every
    // start time ps reports; argv is what identifies the agent then.
    const { agent } = await spawnTree(TREE);
    fs.writeFileSync(pidFile, `${agent}\nThu Jan  1 00:00:00 1970\n`);
    expect(runKill("sleep")).toBe("terminated");
    expect(await gone(agent)).toBe(true);
  });

  it("falls back to argv when no start time was recorded", async () => {
    const { agent } = await spawnTree(TREE);
    fs.writeFileSync(pidFile, `${agent}\n`);
    expect(runKill("/not/the/agent")).toBe("pid-reused");
    expect(alive(agent)).toBe(true);
    fs.writeFileSync(pidFile, `${agent}\n`);
    expect(runKill("sleep")).toBe("terminated");
    expect(await gone(agent)).toBe(true);
  });

  it("escalates to SIGKILL for an agent that ignores SIGTERM", async () => {
    const { agent } = await spawnTree(`trap '' TERM; sleep 300 & printf '%s\\n' "$!" > "$1"; wait`);
    expect(alive(agent)).toBe(true);

    expect(runKill("sh", 1)).toBe("killed");
    expect(await gone(agent)).toBe(true);
  });

  it("does nothing when the recorded pid is gone", async () => {
    const { agent } = await spawnTree(`printf '%s\\n' "$$" > "$1"; exit 0`);
    expect(await gone(agent)).toBe(true);

    expect(runKill("sleep")).toBe("already-gone");
  });

  it("does nothing when there is no pid file", () => {
    expect(runKill("sleep")).toBe("already-gone");
  });

  it("refuses a pid that now belongs to something else", () => {
    // The pid file names THIS test runner. Its command line is not the
    // agent's, so the script must leave it alone — or this test would not
    // be here to report the result.
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    expect(runKill("/definitely/not/the/agent/binary")).toBe("pid-reused");
    expect(alive(process.pid)).toBe(true);
  });

  it("does nothing, and clears the file, for a recorded pid that has exited", async () => {
    const { agent } = await spawnTree(`printf '%s\\n' "$$" > "$1"; exit 0`);
    expect(await gone(agent)).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(runKill("sleep")).toBe("already-gone");
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe("assertRemoteVersion", () => {
  it("accepts the Marid banner when the version matches the gateway", () => {
    expect(assertRemoteVersion("build-box", productBanner("0.33.3"), "0.33.3")).toBe("0.33.3");
  });

  it("accepts a bare version from a pre-rebrand build when it matches", () => {
    expect(assertRemoteVersion("build-box", "0.33.3", "0.33.3")).toBe("0.33.3");
  });

  it("refuses a different version in either format, with the install hint", () => {
    for (const line of [productBanner("0.32.0"), "0.32.0"]) {
      expect(() => assertRemoteVersion("build-box", line, "0.33.3"))
        .toThrow("build-box runs jinn-cli 0.32.0 but this gateway is 0.33.3 — run `npm install -g jinn-cli@0.33.3` there");
    }
  });

  it("refuses output that is not a version, quoting it with the install hint", () => {
    for (const line of ["", "jinn: command not found", "Marid 0.33 (built on Jinn)"]) {
      expect(() => assertRemoteVersion("build-box", line, "0.33.3"))
        .toThrow(`unrecognised \`jinn --version\` output: ${JSON.stringify(line)}`);
      expect(() => assertRemoteVersion("build-box", line, "0.33.3"))
        .toThrow("run `npm install -g jinn-cli@0.33.3` there");
    }
  });

  it("does not accept a version that merely contains the gateway's", () => {
    expect(() => assertRemoteVersion("build-box", productBanner("10.33.3"), "0.33.3")).toThrow("runs jinn-cli 10.33.3");
    expect(() => assertRemoteVersion("build-box", "0.33.30", "0.33.3")).toThrow("runs jinn-cli 0.33.30");
  });
});
