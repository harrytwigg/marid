#!/usr/bin/env node
// A stand-in for the Muse Code CLI's `muse serve`: the Muse Session Protocol
// (MSP v1) as one JSON-RPC 2.0 message per line over stdio, shaped from
// Muse Code 1.4.8's own schema and from frames captured off the real binary.
//
// It models what the adapter relies on:
//   - nothing answers before `initialize` + `initialized` (`notInitialized`);
//   - a session's `config.mcpServers` is refused (`capabilityRequired`) unless
//     the client asked for the `sessionMcp` capability in `initialize`, as the
//     real binary does;
//   - sessions live in a state directory shared by every process, so a later
//     process can resume what an earlier one started (`FAKE_MUSE_STATE_DIR`,
//     default <tmp>/fake-muse-state), and an unknown id is `sessionNotFound`;
//   - `turn/start` answers at once and the turn then runs on its own: the
//     answer streams as `item/delta`, `turn/foregroundCompleted` arrives while
//     a blocking reminder child is still running, and only `turn/completed`
//     ends the turn;
//   - closing stdin ends the host (exit 0), as the real one does.
//
// Turn behaviour is steered by directive words after the prompt's LAST `---`
// line (a fresh session's prompt is `<system prompt>\n\n---\n\n<message>`, so a
// directive goes in a final `---` section):
//   TOOL        one tool call (bash, args {"command":"ls"}) with visible output,
//               then the answer
//   QUOTA       the turn fails with a typed quota error (tier limit) whose reset
//               is FAKE_MUSE_RESET_MS (epoch ms; default two hours ahead)
//   RETRY       two `turn/modelRetryScheduled` (HTTP 429), then the answer
//   HANG        the turn runs until `turn/interrupt`, then completes `cancelled`
//   STUCK       the turn runs and ignores `turn/interrupt` (needs a SIGTERM)
//   AUTH        the turn fails with an `authRequired` error
//   FAIL        the turn fails with a plain model error
//   APPROVAL    the turn asks the client to approve a tool call and waits (3 s)
//               for `approval/decide`; the answer names the choice it got
//   USERINPUT   the turn asks the user a question and waits (3 s) for
//               `userInput/cancel`; the answer says it was declined
//   USAGE       a `usage/changed` subscription snapshot arrives before the end
//   EXIT        the host dies (exit 3) in the middle of the answer
//   NOTFOUND    the turn answers, then the session is dropped from the store, so
//               the NEXT resume of it is `sessionNotFound`
//   NOANSWER    the turn completes with no agent message at all
// Environment hooks:
//   FAKE_MUSE_LOG        one JSON line per request received, and one for the process start
//   FAKE_MUSE_STATE_DIR  where sessions are kept; FAKE_MUSE_RESET_MS the reset QUOTA reports
//   FAKE_MUSE_RESUME_FAIL  a message: every `session/resume` fails with it (invalid params)
//   FAKE_MUSE_IN_USE     every `session/resume` is refused as `sessionInUse`, as when a terminal holds the session
//   FAKE_MUSE_BOOT_EXIT  exit with this code before reading anything (a host that cannot start)
//   FAKE_MUSE_NO_GRANT   grant no capability, whatever is asked for
import fs from "node:fs";
import readline from "node:readline";
import { fail, log, notify, out, readSession, reply, sessionFile, sessionView, uuid7, writeSession } from "./fake-muse-store.mjs";

if (process.env.FAKE_MUSE_BOOT_EXIT) {
  process.stderr.write("fake muse: cannot start (boot refused)\n");
  process.exit(Number(process.env.FAKE_MUSE_BOOT_EXIT));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let initialized = false;
let granted = [];
let interruptTurn = null; // set while a turn is waiting on an interrupt
const serverReplies = new Map(); // server-request id -> resolver
const commands = new Map(); // method -> resolver of the next such command
let nextServerId = 1;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // A response to a request this host made (the presentation receipt).
    serverReplies.get(message.id)?.(message);
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.method === "initialized") { initialized = true; return; }
  if (message.id === undefined) return;
  handle(message);
});
rl.on("close", () => {
  // The real host announces the end of its sessions, then leaves.
  process.exit(0);
});

function handle({ id, method, params }) {
  if (method === "initialize") {
    granted = process.env.FAKE_MUSE_NO_GRANT ? [] : (params?.capabilities?.requestedCapabilities ?? []).filter((c) => c === "sessionMcp");
    return reply(id, {
      experimentalApi: false,
      grantedCapabilities: granted,
      platformFamily: "unix",
      sandboxAvailability: "unavailable",
      schema: { fingerprint: "sha256:fake", version: 1 },
      serverInfo: { name: "muse", version: "1.4.8" },
      sessionDurability: "durable",
    });
  }
  if (!initialized) return fail(id, -32002, "not initialized", { kind: "notInitialized" });
  switch (method) {
    case "session/start": return startSession(id, params);
    case "session/resume": return resumeSession(id, params);
    case "session/setModel": return setModel(id, params);
    case "turn/start": return startTurn(id, params);
    case "turn/interrupt": return interrupt(id, params);
    case "approval/decide":
    case "userInput/cancel":
      commands.get(method)?.(params);
      return reply(id, { commandId: params.commandId, status: "accepted" });
    default:
      return fail(id, -32601, `method not found: ${method}`, { kind: "methodNotFound" });
  }
}

function needsMcpCapability(id, params) {
  if (!params.config?.mcpServers || granted.includes("sessionMcp")) return false;
  fail(id, -32010, "session MCP configuration requires the sessionMcp capability", { kind: "capabilityRequired", capability: "sessionMcp", retryable: false });
  return true;
}

function startSession(id, params) {
  if (needsMcpCapability(id, params)) return;
  const session = { sessionId: uuid7(), modelId: params.modelId, workspaceRoot: params.workspaceRoot, turns: 0 };
  writeSession(session);
  const view = sessionView(session);
  notify("session/started", { session: view });
  reply(id, { session: view, viewCursor: `v3:${session.sessionId}:2` });
}

function resumeSession(id, params) {
  if (needsMcpCapability(id, params)) return;
  if (process.env.FAKE_MUSE_RESUME_FAIL) return fail(id, -32602, process.env.FAKE_MUSE_RESUME_FAIL, { kind: "invalidParams" });
  if (process.env.FAKE_MUSE_IN_USE) {
    return fail(id, -32021, `session ${params.sessionId} is already in use`, { kind: "sessionInUse", retryable: false, sessionId: params.sessionId });
  }
  const session = readSession(params.sessionId);
  if (!session) {
    return fail(id, -32020, `session ${params.sessionId} not found`, { kind: "sessionNotFound", retryable: false, sessionId: params.sessionId });
  }
  reply(id, {
    history: { items: null, mode: "none", noneReason: "excluded", snapshot: null },
    pendingRequests: [],
    session: sessionView(session),
  });
}

function setModel(id, params) {
  const session = readSession(params.sessionId);
  if (!session) return fail(id, -32020, "session not found", { kind: "sessionNotFound" });
  session.modelId = params.model.modelId;
  writeSession(session);
  reply(id, { commandId: params.commandId, status: "accepted" });
}

function interrupt(id, params) {
  reply(id, { commandId: params.commandId, status: "accepted", turnId: params.turnId ?? "" });
  interruptTurn?.();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function directivesOf(text) {
  const tail = text.split(/\n---\n/).at(-1) ?? "";
  return new Set(tail.split(/\s+/).filter(Boolean));
}

function startTurn(id, params) {
  const session = readSession(params.sessionId);
  if (!session) return fail(id, -32024, "session not loaded", { kind: "sessionNotLoaded" });
  const text = params.input.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const turnId = params.commandId;
  reply(id, { commandId: params.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId });
  void runTurn({ session, turnId, text, params });
}

const item = (turnId, fields) => ({ turnId, revision: 1, ...fields });

async function runTurn({ session, turnId, text, params }) {
  const sessionId = session.sessionId;
  const directives = directivesOf(text);
  const base = { sessionId };
  notify("session/statusChanged", { ...base, status: "running" });
  notify("turn/started", { ...base, turnId });
  notify("item/completed", { ...base, item: item(turnId, { itemId: uuid7(), kind: "userMessage", status: "completed", text }) });
  notify("item/started", { ...base, item: item(turnId, { itemId: uuid7(), kind: "reminderChild", status: "inProgress", reminderAgentId: "skill-reminder", childSessionId: uuid7() }) });
  // A reasoning item is announced and committed; the adapter must never show it.
  const reasoningId = uuid7();
  notify("item/started", { ...base, item: item(turnId, { itemId: reasoningId, kind: "reasoning", status: "inProgress", summary: [] }) });
  notify("item/completed", { ...base, item: item(turnId, { itemId: reasoningId, kind: "reasoning", status: "completed", summary: ["private reasoning that must not be shown"] }) });

  if (directives.has("RETRY")) {
    for (const attempt of [1, 2]) {
      notify("turn/modelRetryScheduled", { ...base, turnId, attempt, nextAttempt: attempt + 1, maxAttempts: 10, retryDelayMs: 1000, errorKind: "rate_limited", httpStatus: 429, system: "meta" });
      await sleep(20);
    }
  }
  if (directives.has("AUTH")) return finish(base, turnId, { terminal: "failed", error: { kind: "authRequired", message: "Not signed in to Meta", retryable: false } });
  if (directives.has("QUOTA")) {
    const resetsAtMs = Number(process.env.FAKE_MUSE_RESET_MS || Date.now() + 2 * 3600 * 1000);
    return finish(base, turnId, {
      terminal: "failed",
      reason: "API error 429: Usage limit reached (tier_limit_error)",
      error: { kind: "modelError", message: "API error 429: Usage limit reached (tier_limit_error)", quota: { limitKind: "tierLimit", resetsAtMs }, retryable: false },
    });
  }
  if (directives.has("FAIL")) return finish(base, turnId, { terminal: "failed", error: { kind: "modelError", message: "The model stopped: simulated failure", retryable: false } });
  if (directives.has("HANG") || directives.has("STUCK")) return hang(base, turnId, directives.has("STUCK"));
  if (directives.has("TOOL")) await toolCall(base, turnId);
  if (directives.has("APPROVAL")) {
    const choice = await approval(base, turnId);
    await answer(base, turnId, `approval decided: ${choice ?? "no decision"}`, directives);
  } else if (directives.has("USERINPUT")) {
    const declined = await userInput(base, turnId);
    await answer(base, turnId, declined ? "question declined" : "question never answered", directives);
  } else if (!directives.has("NOANSWER")) {
    await answer(base, turnId, `fake muse: ${text}`, directives);
  }
  if (directives.has("USAGE")) {
    notify("usage/changed", { observedAtMs: Date.now(), tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300, resetsAtMs: Date.now() + 3600_000 }, weekly: { usedPercent: 17, resetsAtMs: Date.now() + 86400_000 } });
  }
  session.turns = (session.turns ?? 0) + 1;
  if (directives.has("NOTFOUND")) fs.rmSync(sessionFile(sessionId), { force: true });
  else writeSession(session);
  // The foreground is done but a blocking reminder is still running: not the end.
  notify("turn/foregroundCompleted", { ...base, turnId, blockingAgents: ["goal-reminder"] });
  await sleep(150);
  notify("item/completed", { ...base, item: item(turnId, { itemId: uuid7(), kind: "reminderChild", status: "completed", reminderAgentId: "goal-reminder", blocking: true }) });
  await finish(base, turnId, { terminal: "completed", usage: { inputTokens: 100, cachedTokens: 20, outputTokens: 5, reasoningTokens: 0 } });
}

async function answer(base, turnId, text, directives) {
  const itemId = uuid7();
  notify("item/started", { ...base, item: item(turnId, { itemId, kind: "agentMessage", status: "inProgress", text: "" }) });
  const half = Math.ceil(text.length / 2);
  notify("item/delta", { ...base, itemId, field: "text", delta: text.slice(0, half) });
  if (directives.has("EXIT")) { await sleep(30); process.exit(3); }
  await sleep(10);
  notify("item/delta", { ...base, itemId, field: "text", delta: text.slice(half) });
  notify("item/completed", { ...base, item: item(turnId, { itemId, kind: "agentMessage", status: "completed", messagePhase: "finalAnswer", text, revision: 2 }) });
  notify("session/tokenUsage", { ...base, turnId, usage: { inputTokens: 100, cachedTokens: 20, outputTokens: 5, reasoningTokens: 0 }, cumulative: { promptTokens: 100, outputTokens: 5, totalTokens: 105 } });
  notify("session/contextUsage", { ...base, usedTokens: 105, windowTokens: 200000, pressure: "normal" });
}

async function toolCall(base, turnId) {
  const itemId = uuid7();
  const open = { itemId, kind: "toolCall", status: "inProgress", tool: "bash", callId: "call_1", args: JSON.stringify({ command: "ls" }) };
  notify("item/started", { ...base, item: item(turnId, open) });
  await sleep(20);
  notify("item/completed", { ...base, item: item(turnId, { ...open, status: "completed", visibleOutput: "file1\nfile2", revision: 2 }) });
}

/** Ask the client to approve a call; resolves with the choice it picked. */
async function approval(base, turnId) {
  const requestId = `srv-${nextServerId++}`;
  const approvalId = uuid7();
  const params = {
    ...base,
    approvalId,
    turnId,
    toolName: "bash",
    toolCallId: "call_1",
    itemId: uuid7(),
    rawArgs: "{\"command\":\"rm -rf build\"}",
    currentRequirementId: { approvalId, sourceIndex: 0 },
    availableChoices: [
      { choiceId: "deny", decision: "denied", label: "No", scope: "once" },
      { choiceId: "allow-session", decision: "approvedForSession", label: "Yes, for this session", scope: "session" },
      { choiceId: "allow-once", decision: "approved", label: "Yes", scope: "once" },
    ],
  };
  const receipt = new Promise((resolve) => serverReplies.set(requestId, resolve));
  const decided = new Promise((resolve) => commands.set("approval/decide", resolve));
  out({ id: requestId, method: "approval/request", params });
  const winner = await Promise.race([decided, sleep(3000).then(() => undefined)]);
  await Promise.race([receipt, sleep(10)]);
  return winner?.choiceId;
}

/** Ask the user a question; resolves true when the client declined it. */
async function userInput(base, turnId) {
  const requestId = `srv-${nextServerId++}`;
  const userInputId = uuid7();
  const declined = new Promise((resolve) => commands.set("userInput/cancel", resolve));
  out({
    id: requestId,
    method: "userInput/request",
    params: { ...base, turnId, userInputId, itemId: uuid7(), toolCallId: "call_2", toolName: "ask", questions: [{ id: "q1", header: "Q", question: "Proceed?", options: [], selection: { mode: "single" } }] },
  });
  return (await Promise.race([declined, sleep(3000).then(() => undefined)])) !== undefined;
}

async function hang(base, turnId, ignoreInterrupt) {
  const itemId = uuid7();
  notify("item/started", { ...base, item: item(turnId, { itemId, kind: "agentMessage", status: "inProgress", text: "" }) });
  notify("item/delta", { ...base, itemId, field: "text", delta: "working on it" });
  if (ignoreInterrupt) return; // runs until the process is signalled
  await new Promise((resolve) => { interruptTurn = resolve; });
  interruptTurn = null;
  await finish(base, turnId, { terminal: "cancelled", reason: "interrupted by client" });
}

async function finish(base, turnId, fields) {
  notify("session/statusChanged", { ...base, status: "idle" });
  notify("turn/completed", { ...base, turnId, durationMs: 150, ...fields });
}
