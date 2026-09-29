import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";

/**
 * Live smoke test of opencode server mode against a REAL opencode.
 *
 * Skipped unless OPENCODE_LIVE_SMOKE=1 — it spends model tokens and needs a
 * signed-in opencode. It is the check the unit suites cannot make: that the
 * real CLI's `serve`, `run --attach` and `attach` behave the way the fake one
 * does. Run on build-host with:
 *
 *   OPENCODE_LIVE_SMOKE=1 OPENCODE_BIN=~/.opencode/bin/opencode \
 *   OPENCODE_SMOKE_MODEL=opencode-go/deepseek-v4.1-flash \
 *   [OPENCODE_SMOKE_SSH=builder@127.0.0.1 OPENCODE_SMOKE_ROOT=/some/dir] \
 *   pnpm exec vitest run src/engines/__tests__/opencode-live-smoke.test.ts
 *
 * OPENCODE_SMOKE_SSH adds the remote leg: the same flow with the server, the
 * turns and the terminal carried over ssh to that host (which may be this one).
 *
 * Both legs run in directories that are NOT git repositories, on purpose: that
 * is where opencode 1.18.31's `run --attach` exits before the answer (see
 * opencode-server-turn.ts), and where the junior pair's remote cwd sits. The
 * test asserts it, so it stays the regression test for that bug.
 */

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const LIVE = process.env.OPENCODE_LIVE_SMOKE === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const MODEL = process.env.OPENCODE_SMOKE_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const SSH = process.env.OPENCODE_SMOKE_SSH;
const ROOT = process.env.OPENCODE_SMOKE_ROOT;

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { OpencodeInteractiveEngine } from "../opencode-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME, GATEWAY_INFO_FILE } from "../../shared/paths.js";
import { USER_STOP_INTERRUPTION_REASON } from "../../sessions/workflow-interruptions.js";
import type { EngineRunOpts, RemoteTarget } from "../../shared/types.js";
import type { PtyControlEvent } from "../pty-view-engine.js";
import headlessXterm from "@xterm/headless";

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await check(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b./g, "");

const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups) c(); });

function flow(label: string, target: RemoteTarget, remote?: { root: string; mount: string }) {
  it(`${label}: attached turns, a live terminal, an interrupt that really stops the turn`, async () => {
    const sessionId = `smoke-${label}-${Date.now()}`;
    expect(isGitRepo(target.remoteCwd ?? JINN_HOME), "the smoke must run outside a git repository").toBe(false);
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, {
      bin: () => BIN,
      ...(remote ? { remote: () => remote, gatewayPort: () => 1 } : {}),
      limits: () => ({ startTimeoutMs: 60_000 }),
    });
    const engine = new OpencodeEngine({ mode: () => "server", servers: pool, ...(remote ? { remote: () => remote, gatewayPort: () => 1 } : {}) });
    const view = new OpencodeInteractiveEngine(engine, pool, { mode: () => "server", bin: () => BIN });
    cleanups.push(() => { view.killAll(); engine.killAll(); void pool.stopAll(); });
    const opts = (over: Partial<EngineRunOpts>): EngineRunOpts => ({
      prompt: "", cwd: JINN_HOME, sessionId, bin: BIN, model: MODEL, ...target, ...over,
    });
    const statusOf = async () => {
      const server = pool.get(sessionId)!;
      const res = await fetch(`${server.apiUrl}/session/status`, { headers: { authorization: basicAuthHeader(server.password) } });
      return await res.json() as Record<string, unknown>;
    };

    // 1. A first turn creates the opencode session on a fresh server.
    const one = await engine.run(opts({ prompt: "Reply with exactly: SMOKE_ONE_OK" }));
    expect(one.error).toBeUndefined();
    expect(one.result).toContain("SMOKE_ONE_OK");
    expect(one.sessionId).toMatch(/^ses_/);
    const server = pool.get(sessionId)!;
    expect(server).toBeDefined();

    // 2. The terminal attaches to that server and shows the session's history.
    let screen = "";
    const controls: PtyControlEvent[] = [];
    // The same bytes through a terminal emulator: opencode's TUI redraws only
    // the cells that changed, so what it shows is not always a substring of
    // what it sent.
    const term = new headlessXterm.Terminal({ cols: 140, rows: 45, allowProposedApi: true });
    cleanups.push(() => term.dispose());
    const sub = view.subscribeWithSnapshot(sessionId, (d) => { screen += d.toString(); term.write(d); }, (e) => {
      controls.push(e);
      if (e.type === "reset") term.reset();
      if (e.type === "snapshot") term.write(e.snapshot.data);
    });
    const rows = async () => {
      await new Promise<void>((resolve) => term.write("", resolve));
      const buffer = term.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
    };
    sub.start();
    view.ensureIdleSpawn(sessionId, { cwd: JINN_HOME, engineSessionId: one.sessionId, cols: 140, rows: 45, ...target });
    await waitFor(() => view.hasWarmPty(sessionId), 60_000);
    const visible = () => stripAnsi(screen + JSON.stringify(controls));
    await waitFor(() => visible().includes("SMOKE_ONE_OK"), 60_000);

    // 3. A resumed turn that runs a long tool, stopped mid-tool as the chat's
    //    Stop does: the server must report the session idle afterwards, not
    //    carry on.
    const longPrompt = "Use your bash tool to run exactly `sleep 45; echo SLEPT_THROUGH`, then reply DONE.";
    const long = engine.run(opts({ resumeSessionId: one.sessionId, prompt: longPrompt }));
    await waitFor(async () => Object.keys(await statusOf()).length > 0, 90_000);
    await new Promise((r) => setTimeout(r, 4000));
    engine.kill(sessionId, USER_STOP_INTERRUPTION_REASON);
    const interrupted = await long;
    expect(interrupted.error).toBe(USER_STOP_INTERRUPTION_REASON);
    expect(await statusOf()).toEqual({});

    // 3b. QA B1: an interrupt fired the moment the prompt's POST returns —
    //     before opencode has picked it up — must still stop it on the server.
    const realFetch = globalThis.fetch;
    let earlyPost: { url: string; messageID: string; parts: Array<{ text?: string; synthetic?: boolean }> } | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (String(input).endsWith("/prompt_async") && !earlyPost) {
        const body = JSON.parse(String(init?.body)) as { messageID: string; parts: NonNullable<typeof earlyPost>["parts"] };
        earlyPost = { url: String(input), messageID: body.messageID, parts: body.parts };
        engine.kill(sessionId, "Interrupted: early");
      }
      return res;
    }) as typeof fetch;
    let early;
    try {
      early = await engine.run(opts({ resumeSessionId: one.sessionId, prompt: "Count from 1 to 60, one number per line, then write SMOKE_EARLY_DONE." }));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(early.error).toBe("Interrupted: early");
    await new Promise((r) => setTimeout(r, 3000));
    const stored = await (await fetch(earlyPost!.url.replace("/prompt_async", "/message"), {
      headers: { authorization: basicAuthHeader(pool.get(sessionId)!.password) },
    })).json() as Array<{ info: { role: string; parentID?: string; error?: { name?: string } }; parts: Array<{ text?: string }> }>;
    const earlyReplies = stored.filter((m) => m.info.role === "assistant" && m.info.parentID === earlyPost!.messageID);
    expect(JSON.stringify(earlyReplies)).not.toContain("SMOKE_EARLY_DONE");
    for (const reply of earlyReplies) expect(reply.info.error?.name).toBe("MessageAbortedError");
    expect(await statusOf()).toEqual({});

    // step 3's request, which the user stopped, was named to the
    //     model as stopped on the next prompt, step 3b's.
    expect(earlyPost!.parts).toHaveLength(2);
    expect(earlyPost!.parts[0]!.synthetic).toBe(true);
    expect(earlyPost!.parts[0]!.text).toContain("the user stopped");
    expect(earlyPost!.parts[0]!.text).toContain(`> ${longPrompt}`);

    // 3c. QA B2: an operator prompt put into the same session mid-turn is not
    //     the turn's answer. step 3's request is not named again —
    //     3b's prompt, which named it, is still in the history the model reads
    //     (and 3b's own stop was Jinn's, which is not named). A model told
    //     nothing took the `sleep 45` up here (3/16 runs on 2026-09-27), which
    //     also cost the turn its answer.
    let jinnParts: Array<{ text?: string; synthetic?: boolean }> = [];
    let jinnPrompt: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/prompt_async")) {
        const body = JSON.parse(String(init?.body)) as { messageID: string; parts: typeof jinnParts };
        jinnPrompt = body.messageID;
        jinnParts = body.parts;
      }
      return await realFetch(input, init);
    }) as typeof fetch;
    let jinn: ReturnType<typeof engine.run>;
    try {
      jinn = engine.run(opts({ resumeSessionId: one.sessionId, prompt: "Count from 1 to 30, one number per line, then write SMOKE_JINN_DONE." }));
      await waitFor(async () => Object.keys(await statusOf()).length > 0, 90_000);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(jinnParts).toHaveLength(1);
    await pool.promptAsync(sessionId, one.sessionId, "Reply with exactly: SMOKE_OPERATOR_REPLY");
    const jinnResult = await jinn;
    // Recorded, not asserted: whether the model still took step 3 up.
    const jinnReplies = (await (await fetch(`${server.apiUrl}/session/${one.sessionId}/message`, {
      headers: { authorization: basicAuthHeader(server.password) },
    })).json() as Array<{ info: { role: string; parentID?: string }; parts: Array<{ type: string; tool?: string }> }>)
      .filter((m) => m.info.role === "assistant" && m.info.parentID === jinnPrompt);
    fs.writeFileSync(
      path.join(process.env.OPENCODE_SMOKE_OUT ?? JINN_HOME, `opencode-smoke-${label}-3c-tools.txt`),
      `${JSON.stringify(jinnReplies.flatMap((m) => m.parts).filter((p) => p.type === "tool").map((p) => p.tool))}\n`,
    );
    expect(jinnResult.result).toContain("SMOKE_JINN_DONE");
    expect(jinnResult.result).not.toContain("SMOKE_OPERATOR_REPLY");
    await waitFor(async () => Object.keys(await statusOf()).length === 0, 90_000);

    // 3d. QA R2-1: an operator prompt queued behind the turn that blocks on a
    //     real permission (reading /etc is `external_directory` on 1.18.31)
    //     must not hold the turn open; the turn ends on its own reply.
    const r21 = engine.run(opts({ resumeSessionId: one.sessionId, prompt: "Count from 1 to 20, one number per line, then write SMOKE_R21_DONE." }));
    await waitFor(async () => Object.keys(await statusOf()).length > 0, 90_000);
    await pool.promptAsync(sessionId, one.sessionId, "Use your read tool to read /etc/hostname and reply with its contents.");
    const r21Result = await r21;
    expect(r21Result.result).toContain("SMOKE_R21_DONE");
    // Clear the operator's blocked prompt (as the operator would, with Esc).
    await fetch(`${pool.get(sessionId)!.apiUrl}/session/${one.sessionId}/abort`, {
      method: "POST",
      headers: { authorization: basicAuthHeader(pool.get(sessionId)!.password) },
    });
    await waitFor(async () => Object.keys(await statusOf()).length === 0, 90_000);

    // 4. The same server keeps serving: a third turn, shown live in the terminal.
    //    The operator's aborted request is still unanswered in the history, and
    //    the model may take it up in this turn's own reply saw one
    //    answer just "build-host". What Jinn owes is THIS turn's reply, so the
    //    result must be exactly the last text of the replies to its own prompt
    //    in the server's store; whether the model obeyed is not Jinn's to test.
    //    What IS Jinn's: telling the model that request was cancelled,
    //    in a synthetic part ahead of the prompt.
    let threePrompt: string | undefined;
    let threeParts: Array<{ text?: string; synthetic?: boolean }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/prompt_async")) {
        const body = JSON.parse(String(init?.body)) as { messageID: string; parts: typeof threeParts };
        threePrompt = body.messageID;
        threeParts = body.parts;
      }
      return await realFetch(input, init);
    }) as typeof fetch;
    let three;
    try {
      three = await engine.run(opts({ resumeSessionId: one.sessionId, prompt: "Reply with exactly: SMOKE_THREE_OK" }));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(three.error).toBeUndefined();
    expect(threeParts).toHaveLength(2);
    expect(threeParts[0]!.synthetic).toBe(true);
    expect(threeParts[0]!.text).toContain("> Use your read tool to read /etc/hostname and reply with its contents.");
    const threeReplies = (await (await fetch(`${server.apiUrl}/session/${one.sessionId}/message`, {
      headers: { authorization: basicAuthHeader(server.password) },
    })).json() as Array<{ info: { role: string; parentID?: string }; parts: Array<{ type: string; text?: string; tool?: string; time?: { end?: number } }> }>)
      .filter((m) => m.info.role === "assistant" && m.info.parentID === threePrompt);
    // Recorded, not asserted: whether the model still took the request up.
    const threeTools = threeReplies.flatMap((m) => m.parts).filter((p) => p.type === "tool").map((p) => p.tool);
    fs.writeFileSync(path.join(process.env.OPENCODE_SMOKE_OUT ?? JINN_HOME, `opencode-smoke-${label}-three-tools.txt`), `${JSON.stringify(threeTools)}\n`);
    const ownText = threeReplies.flatMap((m) => m.parts).filter((p) => p.type === "text" && p.text && p.time?.end).at(-1)?.text;
    expect(ownText).toBeDefined();
    expect(three.result).toBe(ownText);
    expect(three.sessionId).toBe(one.sessionId);
    expect(pool.get(sessionId)).toBe(server);
    // The terminal echoes the prompt, so the answer must show on a row BELOW
    // it; and it renders markdown and wraps, so compare the answer's last line
    // with whitespace and markdown marks squeezed out of both.
    const squash = (s: string) => s.replace(/[\s`*_#>┃│]/g, "");
    const answerLine = squash(ownText!.split("\n").filter((l) => l.trim()).at(-1)!);
    const outDir = process.env.OPENCODE_SMOKE_OUT ?? JINN_HOME;
    await waitFor(async () => {
      const shown = await rows();
      let asked = -1;
      shown.forEach((row, i) => { if (row.includes("Reply with exactly: SMOKE_THREE_OK")) asked = i; });
      return asked >= 0 && squash(shown.slice(asked + 1).join("")).includes(answerLine);
    }, 60_000).catch(async (err: unknown) => {
      fs.writeFileSync(path.join(outDir, `opencode-smoke-${label}-three-rows.txt`), `${JSON.stringify(ownText)}\n${(await rows()).join("\n")}\n`);
      throw err;
    });

    // 5. Composer text from the dashboard reaches the session through the API.
    view.writeStdin(sessionId, "Reply with exactly: SMOKE_COMPOSER_OK");
    await waitFor(() => visible().includes("SMOKE_COMPOSER_OK"), 90_000);

    fs.writeFileSync(
      path.join(process.env.OPENCODE_SMOKE_OUT ?? JINN_HOME, `opencode-smoke-${label}.txt`),
      `${visible().slice(-6000)}\n`,
    );
    sub.unsubscribe();
    view.killAll();
    await pool.stopAll();
    await waitFor(() => server.exited, 20_000);
  }, 420_000);
}

/**
 * a new chat opens its terminal while the first turn is starting, so
 * the view comes up with no opencode session to attach to. The real TUI must
 * end up on the turn's session, not on opencode's home screen — a client
 * started bare stays there even through a POST /tui/select-session it gets
 * during its first seconds (it is not listening yet).
 */
function firstTurnFlow(
  label: string,
  target: RemoteTarget,
  remote?: { root: string; mount: string },
  order: "turn-first" | "view-first" = "turn-first",
) {
  const when = order === "turn-first" ? "as a new chat starts" : "just before a new chat's first turn";
  it(`${label}: a terminal opened ${when} shows the first turn, not the home screen`, async () => {
    const sessionId = `smoke-first-${label}-${order}-${Date.now()}`;
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, {
      bin: () => BIN,
      ...(remote ? { remote: () => remote, gatewayPort: () => 1 } : {}),
      limits: () => ({ startTimeoutMs: 60_000 }),
    });
    const engine = new OpencodeEngine({ mode: () => "server", servers: pool, ...(remote ? { remote: () => remote, gatewayPort: () => 1 } : {}) });
    const view = new OpencodeInteractiveEngine(engine, pool, { mode: () => "server", bin: () => BIN });
    cleanups.push(() => { view.killAll(); engine.killAll(); void pool.stopAll(); });

    let screen = "";
    const controls: PtyControlEvent[] = [];
    const sub = view.subscribeWithSnapshot(sessionId, (d) => { screen += d.toString(); }, (e) => controls.push(e));
    sub.start();
    const start = () => engine.run({
      prompt: "Count from 1 to 25, one number per line, then write SMOKE_FIRST_OK.",
      cwd: JINN_HOME, sessionId, bin: BIN, model: MODEL, ...target,
    });
    // The terminal is open before any opencode session exists: opened with the
    // chat (the turn is starting), or before it (the view attaches bare, and
    // the turn's session arrives while the client is still starting up).
    let first: Promise<Awaited<ReturnType<typeof start>>>;
    if (order === "turn-first") {
      first = start();
      view.ensureIdleSpawn(sessionId, { cwd: JINN_HOME, cols: 140, rows: 45, ...target });
    } else {
      view.ensureIdleSpawn(sessionId, { cwd: JINN_HOME, cols: 140, rows: 45, ...target });
      await waitFor(() => view.hasWarmPty(sessionId), 60_000);
      first = start();
    }
    const result = await first;
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("SMOKE_FIRST_OK");
    const visible = () => stripAnsi(screen + JSON.stringify(controls));
    await waitFor(() => visible().includes("SMOKE_FIRST_OK"), 60_000);
    // The raw bytes too: replayed into a terminal emulator they show the screen.
    const out = process.env.OPENCODE_SMOKE_OUT ?? JINN_HOME;
    fs.writeFileSync(path.join(out, `opencode-smoke-first-${label}-${order}.txt`), `${visible().slice(-6000)}\n`);
    fs.writeFileSync(path.join(out, `opencode-smoke-first-${label}-${order}.raw`), screen);
    sub.unsubscribe();
    view.killAll();
    await pool.stopAll();
  }, 240_000);
}

describe.skipIf(!LIVE)("opencode server mode — live smoke", () => {
  flow("local", {});
  firstTurnFlow("local", {});
  firstTurnFlow("local", {}, undefined, "view-first");

  if (SSH && ROOT) {
    // The remote leg: this JINN_HOME stands in for the sshfs mount (the host is
    // this machine), and a gateway.json gives the stage a hook secret.
    if (!fs.existsSync(GATEWAY_INFO_FILE)) {
      fs.writeFileSync(GATEWAY_INFO_FILE, JSON.stringify({ port: 1, secret: "smoke-secret", token: "smoke-token", pid: process.pid }));
      cleanups.push(() => fs.rmSync(GATEWAY_INFO_FILE, { force: true }));
    }
    const [user, host] = SSH.includes("@") ? SSH.split("@") : [undefined, SSH];
    flow("remote", { remoteHost: host!, ...(user ? { remoteUser: user } : {}), remoteCwd: ROOT }, { root: ROOT, mount: JINN_HOME });
    firstTurnFlow("remote", { remoteHost: host!, ...(user ? { remoteUser: user } : {}), remoteCwd: ROOT }, { root: ROOT, mount: JINN_HOME });
    firstTurnFlow("remote", { remoteHost: host!, ...(user ? { remoteUser: user } : {}), remoteCwd: ROOT }, { root: ROOT, mount: JINN_HOME }, "view-first");
  }
});

vi.setConfig({ testTimeout: 420_000 });
