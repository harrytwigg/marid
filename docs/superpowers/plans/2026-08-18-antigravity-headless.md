# Antigravity Managed-Turn Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Jinn Antigravity work turns onto agy's supported stream-JSON protocol so terminal success, quota/network failure, cancellation, and bounded timeout always settle the Jinn queue without restarting the gateway.

**Architecture:** Keep the existing PTY/transcript adapter as the dashboard terminal view, and add a batch `AntigravityHeadlessEngine` for queued work turns. The batch engine owns a detached agy process group, parses explicit `init`, `step_update`, and terminal `result` events, returns the upstream conversation id for resume persistence, and terminates only its own process tree on terminal settlement, cancellation, or a two-hour hard backstop.

**Tech Stack:** TypeScript ES2022, Node `child_process`, Vitest, existing Jinn engine/MCP interfaces.

## Global Constraints

- Never read from or write to the live `~/.jinn` instance during implementation or verification.
- Never bind ports 7777 or 7788 and never kill a process Jinn did not spawn for this test.
- Preserve the existing interactive Antigravity terminal view.
- Keep public code, tests, comments, and fixtures generic; no personal identifiers, customer data, secrets, workspace ids, emails, absolute home-directory paths, or incident payloads.
- Complete focused tests plus `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm ratchet`, and `pnpm footguns`.

---

## Existing infrastructure (`file:line`)

| Path | Existing responsibility / decision |
|---|---|
| `packages/jinn/src/engines/antigravity.ts:31` | Current work adapter claims agy has no print mode/hooks and combines queued work with the dashboard PTY. This premise is stale in agy 1.1.14. |
| `packages/jinn/src/engines/antigravity.ts:48` | Current hard timeout is fourteen days, so a missed terminal event falsely holds the queue for an operationally unbounded interval. |
| `packages/jinn/src/engines/antigravity.ts:150` | Settlement requires a non-empty `latestAnswer`; terminal upstream errors and empty planner rows never arm completion. |
| `packages/jinn/src/engines/antigravity.ts:176` | Current work completion is inferred from private disk transcript rows rather than the supported stdout protocol. |
| `packages/jinn/src/engines/antigravity-protocol.ts:207` | Only a non-tool, non-empty planner `DONE` row is terminal; the incident's quota error plus empty planner rows are invisible. |
| `packages/jinn/src/engines/antigravity-mcp.ts:69` | Existing per-process Jinn identity/capability environment builder is reusable by headless agy. |
| `packages/jinn/src/engines/antigravity-mcp.ts:81` | Existing global Gemini MCP config attachment is guarded and reference-counted across concurrent processes. |
| `packages/jinn/src/gateway/server.ts:659` | Codex already separates a headless work engine from an interactive PTY view; Antigravity should follow this proven seam. |
| `packages/jinn/src/gateway/server.ts:667` | Antigravity currently creates one shared PTY engine and registers it for both work and terminal routing. |
| `packages/jinn/src/engines/grok.ts:580` | Grok proves the explicit-terminal-event pattern: settle from protocol output instead of waiting indefinitely for process-pipe closure. |
| `packages/jinn/src/engines/grok.ts:694` | Grok also has a process exit/close fallback and exactly-once settlement guard that the new adapter can mirror. |
| `packages/jinn/src/engines/__tests__/antigravity.test.ts:13` | Existing Antigravity tests cover only the combined PTY adapter's shape, one optional live smoke, and PTY environment wiring. |
| `packages/jinn/src/engines/__tests__/antigravity-startup-retry.test.ts:139` | Existing fake-PTY tests remain relevant to the dashboard terminal adapter and must stay green after the split. |

Rejected alternatives:

- Extending the disk-transcript terminal heuristic is rejected because the incident's actionable `model unreachable` state never appears as a terminal planner row, while supported stream-JSON already reports the exact error.
- Relying only on `agy --print-timeout` is rejected because the isolated repro proved agy 1.1.14 can return timeout while leaving a managed subprocess orphaned. Jinn must own and signal the detached process group.
- Removing the PTY adapter is rejected because the dashboard terminal is an existing named consumer.

---

### Task 1: Pin the supported agy stream protocol

**Files:**
- Create: `packages/jinn/src/engines/antigravity-headless.ts`
- Create: `packages/jinn/src/engines/__tests__/antigravity-headless.test.ts`

**Interfaces:**
- Consumes: `EngineRunOpts`, `StreamDelta`, `resolveBin`, `buildEngineChildEnv`, and the existing Antigravity MCP attachment helpers.
- Produces: `buildAntigravityHeadlessArgs(opts, prompt): string[]`, `parseAntigravityStreamLine(line): AntigravityParsedLine | null`, and `AntigravityParsedLine { conversationId?, deltas, terminal, result?, error? }`.

- [ ] **Step 1: Write failing parser and argument tests**

Add complete sanitized fixtures matching agy 1.1.14:

```ts
const init = JSON.stringify({
  event: "init",
  conversation_id: "conversation-1",
  init: { model: "example-model", cwd: "/workspace", tools: ["manage_task"], permission_mode: "always-proceed" },
});
const active = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: "conversation-1",
    step_index: 3,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "manage_task",
    tool_info: { name: "manage_task", parameters: { Action: "status", TaskId: "conversation-1/task-1" } },
  },
});
const done = JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: "conversation-1",
    step_index: 3,
    state: "DONE",
    step_type: "tool",
    tool_name: "manage_task",
    duration_seconds: 0.01,
    tool_info: { name: "manage_task", parameters: { Action: "status" }, output: "Task completed." },
  },
});
const success = JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conversation-1",
    status: "SUCCESS",
    response: "finished\n",
    duration_seconds: 9.3,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 3, total_tokens: 12 },
  },
});
const failure = JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conversation-1",
    status: "ERROR",
    response: "",
    error: "There was a network issue connecting to the server.",
    duration_seconds: 2.5,
    num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  },
});
```

Assert that init captures the conversation id, ACTIVE/DONE map to one `tool_use`/`tool_result` lifecycle, SUCCESS is terminal with `result: "finished\n"`, ERROR is terminal with its error, malformed/unknown lines are ignored, and args contain `-p`, `--output-format stream-json`, `--dangerously-skip-permissions`, optional `--conversation`/`--model`, and filter the unrelated `--chrome` flag.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/engines/__tests__/antigravity-headless.test.ts
```

Expected: FAIL because `antigravity-headless.ts` and its parser/arg behavior do not exist on current main.

- [ ] **Step 3: Implement the minimal pure protocol surface**

Implement tolerant record/string helpers, exact event parsing, and argument construction. Do not infer terminal state from tool rows; only `event: "result"` is terminal. Preserve upstream error text and `result.conversation_id`, and emit generic tool deltas without serializing full parameters/output into chat.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Commit the protocol slice**

```bash
git add packages/jinn/src/engines/antigravity-headless.ts packages/jinn/src/engines/__tests__/antigravity-headless.test.ts
git commit -m "fix(antigravity): parse terminal stream events"
```

---

### Task 2: Add exactly-once headless work-turn lifecycle

**Files:**
- Modify: `packages/jinn/src/engines/antigravity-headless.ts`
- Modify: `packages/jinn/src/engines/__tests__/antigravity-headless.test.ts`

**Interfaces:**
- Consumes: Task 1 parser/args plus `ensureAntigravityJinnMcpConfig`, `cleanupAntigravityJinnMcpConfig`, and `antigravityJinnSessionEnv`.
- Produces: `class AntigravityHeadlessEngine implements InterruptibleEngine` with `run`, `kill`, `killAll`, `killIdle`, and `isAlive`.

- [ ] **Step 1: Write failing lifecycle regressions with a complete child-process double**

Mock only `node:child_process.spawn`; keep the parser, result construction, timers, MCP ref-count implementation, and engine state real. Cover these behaviors independently:

1. A managed-task ACTIVE/DONE sequence streams tool deltas but the promise remains pending until terminal SUCCESS.
2. Terminal ERROR settles immediately even when `close` never fires, returns the conversation id/error, and frees `isAlive`.
3. Terminal SUCCESS settles exactly once and returns the explicit response/conversation id.
4. Process exit without a terminal result returns a bounded diagnostic using exit code/stderr.
5. `kill(sessionId)` records an interruption reason and signals only the tracked child/process group.
6. Advancing fake timers through the two-hour hard backstop terminates the tracked process and settles with `Antigravity turn timed out` after the fake process reports exit.
7. Spawn error rejects and releases the MCP config handle/state.

- [ ] **Step 2: Run the focused test and verify RED**

Run the focused Vitest command. Expected: FAIL because the exported engine lifecycle is absent.

- [ ] **Step 3: Implement the minimal batch engine**

Use this lifecycle:

```ts
const ANTIGRAVITY_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const proc = spawn(bin, args, {
  cwd: opts.cwd,
  env: { ...buildEngineChildEnv(process.env), ...antigravityJinnSessionEnv(opts.resolvedMcp) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
```

Keep one `settled` guard. Parse complete stdout lines, settle immediately on explicit terminal result, and use `exit`/`close` only as the crash/no-result fallback. On terminal result, explicit cancellation, or timeout, signal the owned process group (`-proc.pid` on POSIX, `proc.kill` on Windows) so background children cannot survive the turn. Escalate TERM to KILL after two seconds. Always release the ref-counted MCP handle and remove the live-process entry exactly once.

Build the first-turn prompt as `systemPrompt + separator + prompt`; resumed turns send only the new prompt. Append attachment paths using the existing engine convention. Return `numTurns: 1` on SUCCESS and never convert an explicit ERROR into success merely because response text is non-empty.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/engines/__tests__/antigravity-headless.test.ts src/mcp/__tests__/engine-wiring.test.ts
```

Expected: PASS with no warnings or leaked handles.

- [ ] **Step 5: Commit the lifecycle slice**

```bash
git add packages/jinn/src/engines/antigravity-headless.ts packages/jinn/src/engines/__tests__/antigravity-headless.test.ts
git commit -m "fix(antigravity): settle headless work turns"
```

---

### Task 3: Split gateway work and terminal adapters

**Files:**
- Modify: `packages/jinn/src/gateway/server.ts`
- Modify: `packages/jinn/src/engines/__tests__/antigravity.test.ts`

**Interfaces:**
- Consumes: `AntigravityHeadlessEngine` from Task 2 and existing `AntigravityEngine` PTY surface.
- Produces: `engines.get("antigravity")` backed by headless stream-JSON, while `ptyViewEngines.antigravity` remains the current PTY adapter.

- [ ] **Step 1: Write the failing engine-shape test**

Update the existing Antigravity shape coverage so the headless class is required to expose only the `InterruptibleEngine` work surface, while the existing PTY class retains `PtyViewEngine` methods. This is behavior coverage for the split interfaces, not a source-order assertion.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/engines/__tests__/antigravity.test.ts src/engines/__tests__/antigravity-headless.test.ts src/engines/__tests__/antigravity-startup-retry.test.ts
```

Expected: FAIL until the separate headless/interactive instances are wired and imports updated.

- [ ] **Step 3: Wire the split**

In `server.ts`, instantiate:

```ts
const antigravityInteractiveEngine = new AntigravityEngine(antigravityLifecycle);
const antigravityEngine = new AntigravityHeadlessEngine();
```

Register the headless instance in the work `engines` map and the interactive instance in `ptyViewEngines`. Update startup logging and shutdown to call `killAll()` on both. Leave lifecycle disposal and PTY PID accounting attached only to the interactive instance.

- [ ] **Step 4: Run the Antigravity suite and verify GREEN**

Run the focused command from Step 2 plus:

```bash
pnpm --filter jinn-cli exec vitest run src/engines/__tests__/antigravity-protocol.test.ts src/mcp/__tests__/engine-wiring.test.ts
```

Expected: PASS; existing terminal-view retries and MCP wiring remain unchanged.

- [ ] **Step 5: Commit gateway wiring**

```bash
git add packages/jinn/src/gateway/server.ts packages/jinn/src/engines/__tests__/antigravity.test.ts
git commit -m "fix(antigravity): split work and terminal adapters"
```

---

### Task 4: Verify incident acceptance, repository gates, and privacy

**Files:**
- Modify only if a gate exposes a defect directly caused by Tasks 1–3.

**Interfaces:**
- Consumes: completed headless adapter and gateway split.
- Produces: evidence that quota/network failure, managed-task completion, timeout, cancellation, resume identity, and sibling isolation satisfy PLA-139.

- [ ] **Step 1: Run the focused incident regression set**

```bash
pnpm --filter jinn-cli exec vitest run \
  src/engines/__tests__/antigravity-headless.test.ts \
  src/engines/__tests__/antigravity.test.ts \
  src/engines/__tests__/antigravity-startup-retry.test.ts \
  src/engines/__tests__/antigravity-protocol.test.ts \
  src/mcp/__tests__/engine-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all required gates**

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm ratchet
pnpm footguns
```

Expected: all exit 0. If a pre-existing failure appears, record the exact command/output and prove it is unrelated before proceeding.

- [ ] **Step 3: Review the diff and privacy firewall**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- packages/jinn/src/engines packages/jinn/src/gateway/server.ts
pnpm --filter jinn-cli exec vitest run src/shared/__tests__/privacy-guard.test.ts
```

The privacy grep must return no hits. Stage first if the final Task 3 commit has not already captured every intended file.

- [ ] **Step 4: Confirm cleanup and process ownership**

Verify the implementation tests left no owned agy child/process group, no disposable home, no scratch logs, and no modified live-instance files. Do not inspect or terminate unrelated agy/gateway processes.

- [ ] **Step 5: Final commit if gate-only adjustments were required**

```bash
git add <only-the-intended-files>
git commit -m "test(antigravity): cover managed-turn settlement"
```

- [ ] **Step 6: Update PLA-139 for independent review**

Comment with root cause, isolated repro, exact focused/full gate results, commits, changed files, residual risks, and cleanup evidence. Move the existing Todo to `in_review`; do not mark producer-owned work `done`.
