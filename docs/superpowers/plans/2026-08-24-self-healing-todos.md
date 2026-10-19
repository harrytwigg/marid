# Self-Healing Todos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) for this plan. Shared lifecycle/runner files must stay serialized — do not dispatch overlapping write subagents onto `runner.ts`, `workflow-todo-surface.ts`, `trigger-service.ts`, `availability-resume.ts`, or `transitions.ts`.

**Goal:** Eliminate the operator's blocked→Assigned rescue habit. Safe recovery is automatic; only genuine authority decisions reach Needs you.

**Architecture:** Close lifecycle holes first so automation cannot stomp live work. Then add a bounded classifier/controller that reuses the existing availability-resume + claim + respawn-guard machinery. A quiet anomaly detector observes leftover lies and emits nothing when healthy. The dashboard splits today's single Needs you inbox into Recovering automatically / Manager attention / Needs you. Default rollout is classify-only.

**Tech Stack:** TypeScript (ES2022, strict), Vitest, better-sqlite3 (additive tables only), existing Todo transition/claim/event audit, Vite/React 19 dashboard.

**Spec:** the self-healing Todos spec plus the related sticky-owning-workflow, weekly-reset age cap, stale-run guard and deliver failure-End items. The COO land-gate work is in progress in a separate worktree (`build/coo-land-gate`) — inspect only; do not edit `run-closure.ts` `approvedGate()`, `approval-authority.ts`, `workflow-decider-authority.ts`, or the COO-gate editor.

## Global Constraints

- Never auto-start ordinary backlog Todos.
- Never impersonate the operator for routine recovery. Resume events carry a recovery/availability actor plus a resume stamp the operator-actor filter already widens for delegates.
- Never duplicate an active run or compete with its owner. Claim CAS (`claimWorkItem`) is the lock.
- Maximum two automatic recovery attempts per incident. Recurrence history (`work_item_blocks.recurrences`) is preserved.
- Public repo fixtures and docs stay generic. Leak-grep staged diffs before commit.
- Isolated worktree only. Do not restart or test against production ports 7777 or 7788.
- Follow TDD. Historical-incident replay tests exist and fail before production code.
- Default config is `gateway.todoRecovery.mode: classify-only`. `auto` is Jimbo's reviewed gate, not this PR's production default.
- The instance definition patch for the deliver failure-End is proven with a generic fixture; applying it to the live instance is a rollout step, not a repo commit.

---

## File map

**Create**
- `packages/jinn/src/work-items/workflow-ownership.ts` — newest bound `workflowId` from status events
- `packages/jinn/src/work-items/recovery.ts` — incident identity, classification, attempt ledger
- `packages/jinn/src/work-items/recovery-controller.ts` — bounded apply (or classify-only)
- `packages/jinn/src/work-items/anomaly-detect.ts` — quiet detector
- `packages/jinn/src/work-items/attention-lane.ts` — Recovering / Manager / Operator derivation
- `packages/jinn/src/gateway/todo-recovery.ts` — gateway port: re-arm + employee routing without operator impersonation
- matching `__tests__/` files next to each module
- `packages/jinn/src/work-items/__tests__/self-healing-replay.test.ts` — historical incident table
- `packages/jinn/src/work-items/__tests__/recovery-schema.test.ts` — additive table exact-shape

**Modify (lifecycle, serialize)**
- `packages/jinn/src/gateway/workflow-todo-surface.ts` — stale-run guard
- `packages/jinn/src/work-items/availability-resume.ts` — weekly-reset age cap
- `packages/jinn/src/gateway/availability-resume.ts` — stop operator impersonation; restore labels/assignee; use shared ownership
- `packages/jinn/src/workflows/trigger-service.ts` — sticky owning workflow; accept recovery/availability resume stamps
- `packages/jinn/src/work-items/event-log.ts` — new event kinds
- `packages/jinn/src/work-items/migrate.ts` — register additive `work_item_recovery`
- `packages/jinn/src/shared/config-types.ts` + `config.ts` — `gateway.todoRecovery`
- `packages/jinn/src/gateway/server.ts` — start classify/apply sweep next to availability resume
- `packages/jinn/src/gateway/work-item-payload.ts` — `attentionLane` on compact wire
- `packages/jinn/src/work-items/store.ts` — `needsAttentionFor` includes recovering/manager leftovers so Attention/list grouping can split them; parked clock-waits without those lanes stay out

**Modify (dashboard)**
- `packages/web/src/lib/api.ts` — `attentionLane` on compact wire
- `packages/web/src/routes/todos/list/group-items.ts` — three attention groups
- `packages/web/src/routes/todos/needs-you-support.ts` + `needs-you-view.tsx` — lane split
- existing grouping/list tests

**Do not touch**
- the COO land-gate files listed above
- `packages/jinn/template/**` personalization
- production `~/.jinn` workflow definitions in this PR (applying the deliver failure-End is rollout)

---

### Task 1: Historical-incident replay harness (tests first)

**Files:**
- Create: `packages/jinn/src/work-items/__tests__/self-healing-replay.test.ts`
- Create: `packages/jinn/src/work-items/recovery.ts` (types + empty classify that fails tests)
- Test: same

**Interfaces:**
- Produces:
```ts
export const RECOVERY_CLASSES = [
  "transient", "code", "verification", "security", "operator",
] as const;
export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];
export const ATTENTION_LANES = ["recovering", "manager", "operator"] as const;
export type AttentionLane = (typeof ATTENTION_LANES)[number];
export interface RecoveryClassification {
  class: RecoveryClass;
  lane: AttentionLane;
  reason: string;
  owningWorkflowId?: string;
}
export interface RecoveryIncidentInput {
  todo: { id: string; status: string; assignee: string | null; source: string };
  lastRun?: { id: string; outcome: string; error: string | null; endedAt: string | null };
  openRun?: boolean;
  approval?: { state: string; operatorOnly: boolean };
  labels: string[];
  verifyMode?: "trust" | "verify" | "thorough";
}
export function classifyRecovery(input: RecoveryIncidentInput): RecoveryClassification;
```

- [ ] **Step 1: Write the failing replay tests**

Table of representative incidents (generic fixture names only):

```ts
it("transient quota block classifies as recovering, not operator", () => {
  const verdict = classifyRecovery({
    todo: { id: "ACM-1", status: "blocked", assignee: "platform-worker", source: "session" },
    lastRun: { id: "run_old", outcome: "rate_limited", error: "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z", endedAt: "2026-08-20T12:00:00.000Z" },
    labels: ["build"],
  });
  expect(verdict).toMatchObject({ class: "transient", lane: "recovering" });
});

it("code failure routes to manager, not operator", () => {
  const verdict = classifyRecovery({
    todo: { id: "ACM-2", status: "blocked", assignee: "platform-worker", source: "session" },
    lastRun: { id: "run_old", outcome: "crashed", error: "the build step exited with code 1", endedAt: "2026-08-20T12:00:00.000Z" },
    labels: ["build"],
  });
  expect(verdict).toMatchObject({ class: "code", lane: "manager" });
});

it("verification failure routes to the independent verifier lane", () => {
  const verdict = classifyRecovery({
    todo: { id: "ACM-3", status: "blocked", assignee: "platform-worker", source: "session" },
    lastRun: { id: "run_old", outcome: "failed", error: "independent review rejected the diff", endedAt: "2026-08-20T12:00:00.000Z" },
    labels: ["build"],
    verifyMode: "thorough",
  });
  expect(verdict).toMatchObject({ class: "verification", lane: "manager" });
});

it("security/auth-terminal is manager, not a clock retry", () => {
  const verdict = classifyRecovery({
    todo: { id: "ACM-4", status: "blocked", assignee: "platform-worker", source: "session" },
    lastRun: { id: "run_old", outcome: "crashed", error: "401 Unauthorized: invalid api key", endedAt: "2026-08-20T12:00:00.000Z" },
    labels: ["build"],
  });
  expect(verdict).toMatchObject({ class: "security", lane: "manager" });
});

it("operator-only pending approval is Needs you", () => {
  const verdict = classifyRecovery({
    todo: { id: "ACM-5", status: "in_review", assignee: "platform-worker", source: "session" },
    approval: { state: "pending", operatorOnly: true },
    labels: ["build"],
  });
  expect(verdict).toMatchObject({ class: "operator", lane: "operator" });
});

it("ordinary backlog never classifies as recovering", () => {
  const verdict = classifyRecovery({
    todo: { id: "ACM-6", status: "backlog", assignee: null, source: "human" },
    labels: [],
  });
  expect(verdict.lane).not.toBe("recovering");
  expect(verdict.class).toBe("operator"); // no automatic action
});
```

- [ ] **Step 2: Run tests — they fail because `classifyRecovery` is missing**

Run: `pnpm --filter @jinn/jinn exec vitest run src/work-items/__tests__/self-healing-replay.test.ts`

Expected: FAIL, cannot find `classifyRecovery` or it returns undefined.

- [ ] **Step 3: Add the type module and a throwing stub so the test compiles and fails on assertions**

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-24-self-healing-todos.md \
  packages/jinn/src/work-items/recovery.ts \
  packages/jinn/src/work-items/__tests__/self-healing-replay.test.ts
git commit -m "$(cat <<'EOF'
test(todos): replay historical self-healing incidents

Lock the classifier's contract against the audit: transients recover
quietly, code/verify/security go to a manager, only genuine authority
decisions reach Needs you, and backlog never auto-starts.
EOF
)"
```

---

### Task 2: Stale-run guard — stale failure End cannot stomp a newer state

**Files:**
- Modify: `packages/jinn/src/gateway/workflow-todo-surface.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-todo-surface.test.ts`
- Create: `packages/jinn/src/work-items/workflow-ownership.ts` if the runId check wants the shared event reader

**Interfaces:**
- Consumes: `listWorkItemEvents`, current Todo status, `input.runId`
- Produces: `mayReflect('blocked', …)` is false when a newer assigned/executing/in_review/done state is not owned by this run

Rule:

```
blocked reflection is allowed only when the newest status_change that
carries a runId is THIS run, or there is no successor status_change
after this run last wrote. A Todo already at assigned/executing/
in_review/done whose latest status_change is a different run, an
availability/recovery resume, or an operator/employee move is left
untouched. Quiet Todos still at this run's executing/in_review still
go blocked, as today.
```

- [ ] **Step 1: Write the failing tests in `workflow-todo-surface.test.ts`**

```ts
it("does not let a stale failure End stomp a successor executing Todo", () => {
  const id = armedTodo("rearmed while the old End was still firing");
  reflect(id, "executing"); // run_1
  transitions.transition(id, "assigned", "availability-resume", {
    requeue: true,
    detail: { workflowId: "pipeline", availabilityResume: true },
  });
  surface.workflowTodoLifecycle.reflect({
    todoId: id, status: "executing", workflowId: "pipeline", runId: "run_2", nodeId: "plan",
  });

  surface.workflowTodoLifecycle.reflect({
    todoId: id, status: "blocked", workflowId: "pipeline", runId: "run_1", nodeId: "land",
  });

  expect(store.getWorkItem(id)!.status).toBe("executing");
});

it("still blocks a quiet Todo this run itself left executing", () => {
  const id = armedTodo("this run died");
  reflect(id, "executing");
  reflect(id, "blocked", "land");
  expect(store.getWorkItem(id)!.status).toBe("blocked");
});
```

Keep the existing "still reports a dead run" case: an agent moved it to `in_review` with no runId, then the same `run_1` reflects blocked. After the stale-run guard that is a successor (no matching runId, current in_review) — it must NOT stomp. Update that test to expect `in_review` and rename it. Add a same-run in_review→blocked case that still blocks:

```ts
it("still blocks when THIS run reflected in_review and then failed", () => {
  const id = armedTodo("gate parked then the land died");
  reflect(id, "executing");
  reflect(id, "in_review", "gate");
  reflect(id, "blocked", "land");
  expect(store.getWorkItem(id)!.status).toBe("blocked");
});
```

- [ ] **Step 2: Run the new tests — they fail (stale End still stomps)**

- [ ] **Step 3: Implement `mayReflect` blocked guard**

```ts
function latestRunAttribution(todoId: string): { runId?: string; resume?: boolean } {
  const events = listWorkItemEvents(todoId).filter((event) => event.kind === "status_change");
  const last = events.at(-1);
  const detail = last?.detail ?? {};
  return {
    runId: typeof detail.runId === "string" ? detail.runId : undefined,
    resume: detail.availabilityResume === true || detail.recoveryResume === true,
  };
}

function mayReflect(status: WorkflowRunReflection, current: WorkItemStatus, todoId: string, runId: string): boolean {
  if (status === "executing") return current === "backlog" || current === "assigned";
  if (status === "in_review") return !(current === "blocked" && isBlockDeclared(todoId));
  if (status === "blocked") {
    if (current === "done" || current === "cancelled" || current === "escalated") return false;
    const successor = new Set(["assigned", "executing", "in_review"]);
    if (!successor.has(current)) return true;
    const last = latestRunAttribution(todoId);
    if (last.resume) return false;
    if (last.runId !== undefined && last.runId !== runId) return false;
    if (last.runId === undefined) return false; // operator/employee moved it
    return true; // this run still owns the board
  }
  return true;
}
```

Pass `input.runId` into `mayReflect`.

- [ ] **Step 4: Tests pass. Commit.**

```bash
git commit -m "$(cat <<'EOF'
fix(workflows): stale failure Ends cannot stomp a live successor

A rearmed or operator-moved Todo keeps assigned/executing/in_review.
A quiet Todo this run itself left executing still reflects blocked.
EOF
)"
```

---

### Task 3: Weekly-reset age cap — weekly-capped Todos resume after the real reset

**Files:**
- Modify: `packages/jinn/src/work-items/availability-resume.ts`
- Modify: `packages/jinn/src/work-items/__tests__/availability-resume.test.ts`

Current hole: `dueForResume` ages out when `now - endedAt > 24h`, so a weekly cap (true `until` ~6 days) never auto-resumes.

New rule: the 24h age cap applies only when no future-or-present stated/engine-health reset is known. If the failure or engine health named a reset, wait for that instant even if it is >24h away. After the named reset, resume. If the named reset is already in the past and the Todo is older than 24h *past that reset*, then it is history and stays aged out.

- [ ] **Step 1: Failing test**

```ts
it("resumes a weekly-capped Todo after the stated reset, even when endedAt is older than 24h", () => {
  const resetAt = new Date(NOW.getTime() - 60_000).toISOString();
  const { id, runId } = parked("weekly cap", {
    outcome: "rate_limited",
    endedAt: minutesBefore(6 * 24 * 60),
    error: `Usage limit exceeded; try again at ${resetAt}`,
  });
  const port = recorder();
  resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });
  expect(port.calls).toContain(id);
  expect(resumeEvents(id, runId)[0]?.detail).toMatchObject({ source: "stated" });
});

it("does not resume a weekly cap whose reset is still in the future", () => {
  const resetAt = new Date(NOW.getTime() + 2 * 24 * 60 * 60_000).toISOString();
  const { id, runId } = parked("weekly cap still closed", {
    outcome: "rate_limited",
    endedAt: minutesBefore(2 * 24 * 60),
    error: `Usage limit exceeded; try again at ${resetAt}`,
  });
  resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });
  expect(resumeEvents(id, runId)).toHaveLength(0);
});
```

Update the existing "skips a failure old enough…" test: it uses a stated reset already in the past (`QUOTA_WITH_RESET` at 11:30, NOW at 12:00) with endedAt 25h ago. After this change that case SHOULD resume if the stated reset is known. Replace it with a case that named no reset and is >24h old, which still ages out.

- [ ] **Step 2: Run — weekly-cap test fails (aged out)**

- [ ] **Step 3: Implement**

In `dueForResume`:

```ts
const reset = resolveReset(run, now);
const ageMs = now.getTime() - Date.parse(run.endedAt);
const named = reset.source === "stated" || reset.source === "engine-health";
if (!named && ageMs > MAX_RESUMABLE_AGE_MS) return undefined;
if (named && now.getTime() - reset.at > MAX_RESUMABLE_AGE_MS) return undefined;
if (reset.at > now.getTime()) return undefined;
```

Resolve reset BEFORE the age check (currently age-check happens first and never asks).

- [ ] **Step 4: Tests pass. Commit.**

```bash
git commit -m "$(cat <<'EOF'
fix(todos): weekly-capped work resumes after the real reset

The 24h age cap no longer kills a wait whose engine named a later
reopening. Unnamed old failures still age out.
EOF
)"
```

---

### Task 4: Sticky owning workflow, labels, assignee

**Files:**
- Create: `packages/jinn/src/work-items/workflow-ownership.ts`
- Modify: `packages/jinn/src/gateway/availability-resume.ts` (use shared owner; restore extra labels; keep assignee)
- Modify: `packages/jinn/src/workflows/trigger-service.ts`
- Tests: `packages/jinn/src/gateway/__tests__/availability-resume.test.ts`
- Tests: new `packages/jinn/src/workflows/__tests__/owning-workflow-rearm.test.ts`

**Interfaces:**

```ts
export function owningWorkflowId(todoId: string): string | undefined;
```

Newest `status_change` with `detail.workflowId: string` wins — same rule `boundWorkflowId` uses today.

Trigger rule: when `fireTodo` has more than one runnable definition and `owningWorkflowId` is among them, start only that definition. Others are declined as `suppressed` with reason `Todo already belongs to workflow \`<id>\``. If the owner is missing or not runnable, keep today's multi-start behaviour (new work, unlabeled intake).

Never start a run for a Todo already in `backlog` from this path.

Assignee: `availabilityRearm` / recovery re-arm must not clear `assignee` or `department`. Labels: restore the arming label by ADD, never replace the set.

- [ ] **Step 1: Failing tests**

Owning-workflow: two enabled workflows (`intake` unlabeled, `category` label `category`) both trigger on `assigned`. A Todo labelled `category` whose last `workflowId` is `category` is re-armed to `assigned` — only `category` starts.

Labels: a Todo carrying `urgent` plus missing `build` is re-armed — both labels present, assignee unchanged.

Operator impersonation: an operator-filtered trigger still fires when the resume actor is `availability-resume` and `detail.availabilityResume === true`.

- [ ] **Step 2: Run — intake also starts / assignee wiped / operator filter misses**

- [ ] **Step 3: Implement**

1. Extract `owningWorkflowId`.
2. `fireTodo`: if owner is in `runnable`, `runnable = runnable.filter(d => d.definition.id === owner)`.
3. Actor filter: accept `availability-resume` / `todo-recovery` when `event.quotaWindowDecided` or a new `event.armedAsRecovery`.
4. `armingActor` always returns `AVAILABILITY_RESUME_ACTOR` (or recovery actor). Do not write `actor: "operator"`.
5. `restoreArmingLabel` stays add-only; add an assignee assertion test (no code if already sticky).

- [ ] **Step 4: Tests pass. Commit.**

```bash
git commit -m "$(cat <<'EOF'
fix(workflows): re-arm resumes the owning workflow, not intake

A Todo that already belongs to a pipeline stays on it. Recovery no
longer impersonates the operator to satisfy an actor filter.
EOF
)"
```

---

### Task 5: Honest terminal outcomes + approval/status reconciliation

**Files:**
- Modify: `packages/jinn/src/gateway/workflow-todo-surface.ts` `complete()`
- Tests: `packages/jinn/src/gateway/__tests__/workflow-todo-surface.test.ts`
- Tests: generic deliver→failure-End fixture in `packages/jinn/src/workflows/__tests__/landing-evidence.test.ts` (the deliver failure-End pattern)

`complete()` today no-ops unless status is `in_review`. Acceptance: approved/landed work cannot remain indefinitely in_review. If the reserved gate approved and the run completed, close from `in_review`. If it is still `executing`/`assigned` because reflection lagged, move to `in_review` then close in the same function — but NEVER close from `blocked`. Do not change `approvedGate()` (the COO land-gate work owns that).

Deliver failure-End: add a generic workflow whose `deliver` node has an explicit failure End when `landed` is blocked, so a lying success path is not the only catch. Do not edit the live instance definition in this PR.

- [ ] **Step 1: Failing tests for complete-from-approved-in_review (already exists?) and complete-does-not-close-blocked**

If `complete()` already closes in_review, add the detector-side test in Task 7 for "approved but still open after the run vanished".

- [ ] **Step 2–4: Implement only if a hole remains. Commit.**

```bash
git commit -m "$(cat <<'EOF'
fix(todos): approved landings cannot sit open in review

A reserved-gate completion still closes in_review. Blocked landings
still cannot close. Generic deliver failure-End covers the instance patch.
EOF
)"
```

---

### Task 6: Recovery table + bounded controller

**Files:**
- Create: `packages/jinn/src/work-items/recovery.ts` (ledger + classify)
- Create: `packages/jinn/src/work-items/recovery-controller.ts`
- Create: `packages/jinn/src/gateway/todo-recovery.ts`
- Modify: `packages/jinn/src/work-items/event-log.ts` kinds
- Modify: `packages/jinn/src/work-items/migrate.ts`
- Modify: `packages/jinn/src/shared/config-types.ts`, `config.ts`, `config.test.ts`
- Tests: `recovery.test.ts`, `recovery-controller.test.ts`, `recovery-schema.test.ts`

**DDL (additive, never a column on `work_items`):**

```sql
CREATE TABLE IF NOT EXISTS work_item_recovery (
  work_item_id     TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  incident_id      TEXT NOT NULL,
  class            TEXT NOT NULL CHECK (class IN ('transient','code','verification','security','operator')),
  lane             TEXT NOT NULL CHECK (lane IN ('recovering','manager','operator')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 2),
  last_attempt_at  TEXT,
  last_run_id      TEXT,
  reason           TEXT NOT NULL,
  updated_at       TEXT NOT NULL
)
```

Incident identity: `last settled run id` when present, else `status_change event id` of the current stop. One row per Todo. Attempts increment only on an applied recovery. Classify-only writes the row with `attempts = 0`.

**Controller:**

```ts
export interface RecoveryApplyDeps {
  mode: "off" | "classify-only" | "auto";
  now?: () => Date;
  rearm(todoId: string): AvailabilityRearmResult;
  routeToEmployee?(todoId: string, employee: string, reason: string): void;
  claim(todoId: string, owner: string): ClaimWorkItemResult;
  release(todoId: string, owner: string): void;
}
export function sweepTodoRecovery(deps: RecoveryApplyDeps): { classified: number; applied: number };
```

Apply rules:
- `off`: no-op.
- `classify-only`: classify + persist lane; no status write, no session, no new Todo.
- `auto`:
  - `transient` → re-arm owning workflow via existing port (max 2, skip if open run, skip backlog, skip held claim).
  - `code` → assign remaining employee (existing assignee) if any, re-arm once more (attempt 2 is the scoped repair). After 2 → manager lane, do not escalate to operator unless already operator-only.
  - `verification` → if `verifyPolicy.verifier.employee` set, assign that employee (never the producer). Else manager lane.
  - `security` → manager lane, never retry as clock.
  - `operator` → no auto apply.
- Actor is `todo-recovery`, never `operator`.
- Claim owner `todo-recovery:<incidentId>`. Release if re-arm unavailable.

Wire `gateway.todoRecovery.mode` defaulting to `classify-only` when unset. Validate in `validateConfigShape`.

- [ ] **Step 1: Schema + classify + controller tests (failing)**
- [ ] **Step 2: Confirm red**
- [ ] **Step 3: Implement DDL, classify, controller, gateway port**
- [ ] **Step 4: Green. Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(todos): bounded recovery classifier with classify-only default

Two attempts max, claim-idempotent, no operator impersonation, no
backlog auto-start. Production stays classify-only until Jimbo
enables auto.
EOF
)"
```

---

### Task 7: Quiet anomaly detector

**Files:**
- Create: `packages/jinn/src/work-items/anomaly-detect.ts`
- Tests: `packages/jinn/src/work-items/__tests__/anomaly-detect.test.ts`

**Interfaces:**

```ts
export const ANOMALY_KINDS = [
  "assigned-without-run",
  "execution-timeout",
  "approved-landed-open",
  "review-without-reviewer",
  "blocked-without-recovery",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export interface TodoAnomaly {
  workItemId: string;
  kind: AnomalyKind;
  lane: AttentionLane;
  reason: string;
}
export function detectTodoAnomalies(now?: Date): TodoAnomaly[];
```

Rules:
- assigned-without-run: status `assigned`, no open run, no settled run in last 15m, not backlog, has owning workflow. Lane recovering (auto will re-arm) or manager if already attempted twice.
- execution-timeout: status `executing`, open run's `startedAt` older than 4h and session not `running`/`waiting`.
- approved-landed-open: `in_review`, approval `approved`, latest run completed, Todo not `done`.
- review-without-reviewer: `in_review`, no pending approval, no verifier assignee, no in-flight review session.
- blocked-without-recovery: `blocked`, not parked, no recovery row, not already classified.

Healthy board (backlog/assigned-with-fresh-run/executing-live/in_review-with-pending-gate/done): returns `[]`. Detector never calls `createWorkItem` or `createSession`. In classify-only it only upserts `work_item_recovery` + audit event `anomaly_observed` (once per incident).

- [ ] **Step 1: Failing tests including `creates zero Todos and zero sessions when healthy`**
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Green. Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(todos): quiet anomaly detector that is silent when healthy

Five leftover lies become lanes. A healthy board creates no Todos
and no sessions.
EOF
)"
```

---

### Task 8: Dashboard lanes

**Files:**
- Modify: `packages/jinn/src/gateway/work-item-payload.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/routes/todos/list/group-items.ts`
- Modify: `packages/web/src/routes/todos/needs-you-support.ts`
- Modify: `packages/web/src/routes/todos/needs-you-view.tsx`
- Tests: `list-grouping.test.ts`, `needs-you-view.test.tsx`

Compact wire adds optional `attentionLane: "recovering" | "manager" | "operator" | null`.

Attention/list grouping is fed only from `GET /api/work-items?needsAttentionFor=me` then `deriveNeedsYou`. Both layers must keep recovering/manager leftovers (including parked recovering and `in_review` manager rows). `deriveNeedsYou` is not a Needs-you-only filter.

List grouping: today's single `needs-you` group splits into:
1. `recovering` — "Recovering automatically"
2. `manager` — "Manager attention"
3. `needs-you` — "Needs you" (operator lane only)

Items without a lane keep current behaviour (blocked/escalated/pending approval → needs-you).

`needsAttentionFor` SQL: include open recovering/manager leftovers (including parked rows that already have those lanes). Parked clock-waits without a recovering/manager row stay out. The dashboard then splits Recovering automatically / Manager attention / Needs you. Do not exclude recovering from this feed — grouping is only fed from `needsAttentionFor=me`.

Classifier vs detector: `classifyRecovery` treats approved+completed+`in_review` as manager, not the operator fallback. Sweep must not overwrite a live `anomaly:approved-landed-open` manager row. Conclusive mirrored approved + completed run + `in_review` closes through `complete()`; a refused close (open children) stays `in_review` on Manager attention.

- [ ] **Step 1: Failing grouping tests**
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement wire + groups + inbox copy**
- [ ] **Step 4: Green. Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(web): split Todo attention into recovering / manager / needs you

Clock-waits and automatic retries leave Needs you. Only genuine
authority decisions stay on that lane.
EOF
)"
```

---

### Task 9: Gateway sweep, metrics, rollout docs

**Files:**
- Modify: `packages/jinn/src/gateway/server.ts`
- Create: `packages/jinn/src/gateway/todo-recovery.ts` start/stop
- Modify: plan / this file's rollout section is the operator-facing source of truth

Start an unref'd interval next to `startAvailabilityResumes`. One sweep: classify + anomalies + (if auto) apply. Never overlap ticks. Default classify-only.

Metrics (audit events, no new product analytics):
- `recovery_classified` / `recovery_attempted` / `recovery_exhausted` / `anomaly_observed`
- Counts derived from those events: operator rescues (`status_change` blocked→assigned actor `operator`), recovery latency (`last_attempt_at - last_blocked_at`), duplicate-run refusals (`claim_rejected`), false completion (complete() on blocked — already impossible), avoidable needs-you (classified recovering but still in operator lane)

Rollback: set `gateway.todoRecovery.mode: off` (or omit + we treat unknown as classify-only). Additive table stays; sweeps become no-ops.

- [ ] **Step 1: Test that default mode is classify-only and auto is opt-in**
- [ ] **Step 2–4: Wire server, commit**

```bash
git commit -m "$(cat <<'EOF'
feat(gateway): classify-only Todo recovery sweep

Production default observes and labels. Auto-apply stays behind
Jimbo's reviewed config gate.
EOF
)"
```

---

## Rollout

1. Land this branch. Production config remains unset → classify-only.
2. Watch a few days: recovering vs manager vs operator counts; confirm zero healthy-state Todos/sessions; confirm no duplicate runs.
3. Jimbo reviews and sets `gateway.todoRecovery.mode: auto` on this instance only.
4. Apply the instance `deliver` failure-End using the existing instance-definition tooling after auto is trusted.
5. Rollback: `mode: off`.

## Rollback

`gateway.todoRecovery.mode: off`. Lifecycle invariants (stale-run guard, weekly-reset age cap, sticky owning workflow) stay — they are correctness, not automation. If a lifecycle fix misbehaves, revert that commit independently.

## Remaining risks

- The COO land-gate work is still in progress; reserved-gate close class may land after this. Anomaly `approved-landed-open` must not assume `decidableBy: coo`.
- Operator-filtered triggers after dropping impersonation depend on the resume stamp. Covered by tests; watch first classify-only week.
- Two-attempt cap vs block recurrences: both count; a dependency-kind requeue is not a recovery attempt.
- The instance deliver failure-End is not applied until rollout step 4.
- The sweep is the only writer of a Todo's `work_item_recovery` row; the anomaly detector only appends `anomaly_observed`. A later *generic* operator fallback (`no safe automatic recovery is known`) cannot replace an unresolved `manager`/`recovering` lane. Specific verdicts (failure, leftover manager, pending routed approval, operator-only) may replace. Terminal `done`/`cancelled` means the prior condition resolved. Refused `complete()` (open children) stays `in_review` on Manager attention.

## Leak-grep

Before every commit, run the instance leak-grep from the platform skill against the staged diff. The only OK hits are the public brew tap and the generic COO name Jimbo. Fixture departments stay `platform` / `operations`. Employees stay `platform-worker` / `reviewer`. Never put personal names, project names, emails, or absolute home-directory paths in this repo.
