# Onboarding Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-run onboarding reliably appear, feel personal, and carry the user into a gamified COO setup conversation that hatches their first employee, demos delegation, and creates their first cron.

**Architecture:** `config.portal.onboarded` is the single source of truth. The web wizard (gate fixed, genie icon, engine/model/effort step) completes → persists prefs + global engine default → opens a COO chat. The gateway context builder, seeing `onboarded:false`, injects an operator-aware, second-person onboarding context that drives skippable beats. The genie flips `onboarded:true` at wrap.

**Tech Stack:** TypeScript (gateway, `packages/hundredfold`), React 19 / Next 15 (web, `packages/web`), vitest (gateway tests), Markdown skill playbooks.

## Global Constraints

- **Never touch live `~/.jinn` or the `:7777` gateway.** Validate only on a throwaway instance (e.g. `~/.test-onboarding`) on a non-7777 port, started from a worktree build. Copied verbatim from spec §8.
- **Privacy firewall:** repo code/templates must stay generic — no real names, project names, emails, keys, or `/Users/...` paths. `template/**` is most safety-critical.
- **Node pinned to 24.13.0** for all pnpm/build/run (`.npmrc use-node-version`).
- **Gateway tests use vitest** (`import { test, expect } from "vitest"`), co-located `*.test.ts`. Run: `cd packages/hundredfold && pnpm test`.
- **No `Co-Authored-By` trailers** in commits.
- Build before manual checks: `pnpm build` (turbo).
- `config.portal.onboarded === true` must gate onboarding off (idempotent — never re-fire).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `packages/hundredfold/src/gateway/api.ts` | `needed` flag; `completeOnboarding` persists engine/model/effort | Modify |
| `packages/hundredfold/src/sessions/context.ts` | second-person `buildIdentity`; `buildOnboardingContext` gated on `onboarded` | Modify |
| `packages/hundredfold/src/sessions/context.test.ts` | unit tests for identity + onboarding context | Create |
| `packages/hundredfold/src/gateway/__tests__/onboarding.test.ts` | unit tests for `needed` + completeOnboarding persistence | Create |
| `packages/hundredfold/src/cli/create.ts` | verify setup populated home before success | Modify |
| `packages/hundredfold/src/cli/setup.ts` | `prompt()` resolves on stdin EOF/close | Modify |
| `packages/hundredfold/src/cli/__tests__/create-verify.test.ts` | unit test for the home-populated guard | Create |
| `packages/hundredfold/template/skills/onboarding/SKILL.md` | gamified multi-beat playbook | Rewrite |
| `packages/web/src/components/onboarding-wizard.tsx` | genie icon, engine/model/effort step, launch-into-chat | Modify |
| `packages/web/src/lib/api.ts` | `completeOnboarding` accepts engine/model/effort | Modify |
| `packages/web/src/components/chat/chat-sidebar.tsx` | default focus filter "all" | Modify |

---

## Task 1: Fix the onboarding gate (`needed`)

**Files:**
- Modify: `packages/hundredfold/src/gateway/api.ts` (~1706)
- Test: `packages/hundredfold/src/gateway/__tests__/onboarding.test.ts`

**Interfaces:**
- Produces: GET `/api/onboarding` returns `needed === !onboarded` (independent of employees/sessions).

- [ ] **Step 1: Write the failing test**

Create `packages/hundredfold/src/gateway/__tests__/onboarding.test.ts`:

```ts
import { test, expect } from "vitest";

// Pure replica of the gate rule so we test the policy without booting the server.
function computeNeeded(onboarded: boolean): boolean {
  return !onboarded;
}

test("onboarding is needed when not onboarded, regardless of seeded employee/sessions", () => {
  expect(computeNeeded(false)).toBe(true);
});

test("onboarding is not needed once onboarded flag is set", () => {
  expect(computeNeeded(true)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it passes (policy lock)**

Run: `cd packages/hundredfold && pnpm test onboarding`
Expected: PASS (this pins the intended rule; next step makes the server match it).

- [ ] **Step 3: Change the server gate**

In `api.ts`, the GET `/api/onboarding` handler — replace the `needed` line:

```ts
        needed: !onboarded,
```

(Leave `sessionsCount` and `hasEmployees` in the response for diagnostics; they're no longer part of the gate.)

- [ ] **Step 4: Build + manual verify**

Run: `cd packages/hundredfold && pnpm build` then start a throwaway instance and:
`curl -s http://127.0.0.1:7788/api/onboarding` → `needed:true` on a fresh (employee-seeded, 0-session) instance.

- [ ] **Step 5: Commit**

```bash
git add packages/hundredfold/src/gateway/api.ts packages/hundredfold/src/gateway/__tests__/onboarding.test.ts
git commit -m "fix(onboarding): gate wizard on !onboarded only (was suppressed by seeded employee)"
```

---

## Task 2: Second-person identity (`buildIdentity`)

**Files:**
- Modify: `packages/hundredfold/src/sessions/context.ts` (function `buildIdentity`, ~378)
- Test: `packages/hundredfold/src/sessions/context.test.ts`

**Interfaces:**
- Consumes: `buildIdentity(portalName: string, operatorName?: string, language?: string): string`
- Produces: identity text that addresses the operator in **second person** and contains no "report to … (CEO)" third-person framing.

- [ ] **Step 1: Write the failing test**

Create `packages/hundredfold/src/sessions/context.test.ts`:

```ts
import { test, expect } from "vitest";
import { buildIdentity } from "./context.js";

test("identity addresses the operator in second person, not third", () => {
  const text = buildIdentity("Hui", "John", "English");
  expect(text).toContain("You are Hui");
  expect(text).toMatch(/speaking with .*John|talking with .*John|with \*\*John\*\*/);
  expect(text).toMatch(/second person/i);
  // No third-person "report to John (CEO)" framing that caused "I help John".
  expect(text).not.toMatch(/report to \*\*John\*\* \(CEO\)/);
});

test("identity adds a language directive only for non-English", () => {
  expect(buildIdentity("Hui", "John", "Spanish")).toMatch(/respond in Spanish/i);
  expect(buildIdentity("Hui", "John", "English")).not.toMatch(/respond in English/i);
});
```

- [ ] **Step 2: Export `buildIdentity` and run test to verify it fails**

If `buildIdentity` is not exported, add `export` to its declaration. Run:
`cd packages/hundredfold && pnpm test context`
Expected: FAIL on the second-person assertions.

- [ ] **Step 3: Rewrite `buildIdentity`**

```ts
export function buildIdentity(portalName: string, operatorName?: string, language?: string): string {
  const operatorLine = operatorName
    ? `\n\nThe person you are speaking with is **${operatorName}** — your operator. Address them directly, in the second person ("you"), never in the third person.`
    : "";
  const languageInstruction = language && language !== "English"
    ? `\n\n**Language**: Always respond in ${language}.`
    : "";

  return `# You are ${portalName}

You are ${portalName}, COO of ${operatorName ? `${operatorName}'s` : "the user's"} AI organization. Your full operating manual is in \`CLAUDE.md\` / \`AGENTS.md\` at \`~/.jinn\` (${JINN_HOME}) — auto-loaded by your engine. Follow it.${operatorLine}${languageInstruction}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hundredfold && pnpm test context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hundredfold/src/sessions/context.ts packages/hundredfold/src/sessions/context.test.ts
git commit -m "fix(context): address operator in second person in COO identity"
```

---

## Task 3: `buildOnboardingContext` gated on `onboarded`

**Files:**
- Modify: `packages/hundredfold/src/sessions/context.ts` (replace `buildEvolutionContext` ~655; update call-site ~157)
- Test: `packages/hundredfold/src/sessions/context.test.ts` (extend)

**Interfaces:**
- Consumes: `buildOnboardingContext(opts: { portalName: string; operatorName?: string; onboarded: boolean }): string | null`
- Produces: returns `null` when `onboarded === true`; otherwise an operator-aware onboarding directive that (a) greets by name, (b) forbids re-asking the name, (c) points to the `onboarding` skill, (d) uses instance-safe paths.

- [ ] **Step 1: Write the failing tests**

Append to `context.test.ts`:

```ts
import { buildOnboardingContext } from "./context.js";

test("onboarding context is null once onboarded", () => {
  expect(buildOnboardingContext({ portalName: "Hui", operatorName: "John", onboarded: true })).toBeNull();
});

test("onboarding context greets by name and forbids re-asking it", () => {
  const text = buildOnboardingContext({ portalName: "Hui", operatorName: "John", onboarded: false })!;
  expect(text).toContain("John");
  expect(text).toMatch(/already know|do not ask.*name|don't ask.*name/i);
  expect(text).toMatch(/onboarding/); // points at the skill
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hundredfold && pnpm test context`
Expected: FAIL ("buildOnboardingContext is not a function").

- [ ] **Step 3: Replace `buildEvolutionContext` with `buildOnboardingContext`**

Remove the old `buildEvolutionContext` function and add:

```ts
export function buildOnboardingContext(opts: {
  portalName: string;
  operatorName?: string;
  onboarded: boolean;
}): string | null {
  if (opts.onboarded) return null;
  const { portalName, operatorName } = opts;
  const name = operatorName ? operatorName : "your operator";
  return [
    `## Onboarding mode`,
    `This is a fresh ${portalName} install and you have NOT yet completed onboarding ${operatorName ? `with ${operatorName}` : ""}.`,
    operatorName
      ? `You already know their name is **${operatorName}** (from setup) — greet them by name and DO NOT ask for their name again.`
      : `Ask the user's name once, then use it.`,
    `Run the **onboarding** skill (\`skills/onboarding/SKILL.md\`): a warm, multi-turn, game-like setup where you and ${name} get to know each other and build their org together. Speak in the second person.`,
    `Each beat must offer an explicit skip ("just say 'skip' or 'later'"). Never trap ${name}.`,
    `When onboarding wraps, set \`portal.onboarded: true\` in \`config.yaml\` so this never repeats.`,
  ].join("\n");
}
```

- [ ] **Step 4: Update the call-site (~157)**

Replace the `buildEvolutionContext(portalName)` block:

```ts
  if (!opts.employee) {
    const onboarded = opts.config?.portal?.onboarded === true;
    const onboarding = buildOnboardingContext({ portalName, operatorName, onboarded });
    if (onboarding) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Onboarding mode",
        content: onboarding,
        summary: `## Onboarding mode\nFresh install — run the onboarding skill (see CLAUDE.md).`,
      });
    }
  }
```

- [ ] **Step 5: Run tests + full suite**

Run: `cd packages/hundredfold && pnpm test context` then `pnpm test`
Expected: PASS (no other test referenced `buildEvolutionContext`; if any does, update it).

- [ ] **Step 6: Commit**

```bash
git add packages/hundredfold/src/sessions/context.ts packages/hundredfold/src/sessions/context.test.ts
git commit -m "feat(context): operator-aware onboarding context gated on portal.onboarded"
```

---

## Task 4: Persist engine/model/effort in `completeOnboarding`

**Files:**
- Modify: `packages/hundredfold/src/gateway/api.ts` (POST `/api/onboarding`, ~1716)
- Test: `packages/hundredfold/src/gateway/__tests__/onboarding.test.ts` (extend)

**Interfaces:**
- Consumes: POST body now also accepts `{ engine?: string; model?: string; effortLevel?: string }`.
- Produces: writes `engines.default = engine`, `engines[engine].model = model`, `engines[engine].effortLevel = effortLevel` into config (only for provided values), alongside existing portal fields.

- [ ] **Step 1: Write the failing test**

Append to `onboarding.test.ts` a pure merge helper test:

```ts
type Cfg = { engines: Record<string, any>; portal?: Record<string, any> };

function applyEngineChoice(cfg: Cfg, c: { engine?: string; model?: string; effortLevel?: string }): Cfg {
  if (!c.engine) return cfg;
  const engines = { ...cfg.engines, default: c.engine };
  engines[c.engine] = {
    ...(engines[c.engine] ?? {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effortLevel ? { effortLevel: c.effortLevel } : {}),
  };
  return { ...cfg, engines };
}

test("engine choice sets default + per-engine model/effort", () => {
  const base: Cfg = { engines: { default: "claude", claude: { model: "opus" } } };
  const out = applyEngineChoice(base, { engine: "claude", model: "sonnet", effortLevel: "low" });
  expect(out.engines.default).toBe("claude");
  expect(out.engines.claude.model).toBe("sonnet");
  expect(out.engines.claude.effortLevel).toBe("low");
});
```

- [ ] **Step 2: Run test to verify it passes (policy lock)**

Run: `cd packages/hundredfold && pnpm test onboarding`
Expected: PASS.

- [ ] **Step 3: Wire the helper into the POST handler**

In the POST `/api/onboarding` handler, extend body destructuring and the `updated` object:

```ts
      const { portalName, operatorName, language, engine, model, effortLevel } = body;
      // ... existing portal merge ...
      let engines = config.engines;
      if (engine) {
        engines = { ...config.engines, default: engine };
        engines[engine] = {
          ...(engines[engine] ?? {}),
          ...(model ? { model } : {}),
          ...(effortLevel ? { effortLevel } : {}),
        };
      }
      const updated = {
        ...config,
        engines,
        portal: {
          ...config.portal,
          onboarded: true,
          ...(portalName !== undefined && { portalName: portalName || undefined }),
          ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };
```

- [ ] **Step 4: Build + manual verify**

`pnpm build`; on a throwaway instance POST `{engine:"claude",model:"sonnet",effortLevel:"low"}` and confirm `config.yaml` shows `engines.default: claude`, `engines.claude.model: sonnet`, `effortLevel: low`.

- [ ] **Step 5: Commit**

```bash
git add packages/hundredfold/src/gateway/api.ts packages/hundredfold/src/gateway/__tests__/onboarding.test.ts
git commit -m "feat(onboarding): completeOnboarding persists engine/model/effort as global default"
```

---

## Task 5: `jinn create` success-verification + EOF-safe prompt

**Files:**
- Modify: `packages/hundredfold/src/cli/create.ts` (after `execFileSync(setup)`, before register/success)
- Modify: `packages/hundredfold/src/cli/setup.ts` (`prompt()` resolves on stdin `close`)
- Test: `packages/hundredfold/src/cli/__tests__/create-verify.test.ts`

**Interfaces:**
- Produces: `instanceHomeIsPopulated(home: string): boolean` — true iff `config.yaml` exists in `home`.

- [ ] **Step 1: Write the failing test**

Create `packages/hundredfold/src/cli/__tests__/create-verify.test.ts`:

```ts
import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceHomeIsPopulated } from "../create.js";

test("empty/half-built home is not considered populated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-create-"));
  expect(instanceHomeIsPopulated(dir)).toBe(false);
  fs.writeFileSync(path.join(dir, "config.yaml"), "jinn: {}\n");
  expect(instanceHomeIsPopulated(dir)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hundredfold && pnpm test create-verify`
Expected: FAIL ("instanceHomeIsPopulated is not exported").

- [ ] **Step 3: Add the guard in `create.ts`**

Add and export the helper, and call it after `execFileSync`:

```ts
export function instanceHomeIsPopulated(home: string): boolean {
  return fs.existsSync(path.join(home, "config.yaml"));
}
```

After the `execFileSync(... "setup" ...)` try/catch, before patching config / registering:

```ts
  if (!instanceHomeIsPopulated(home)) {
    console.error(`${RED}Error:${RESET} Setup did not complete for "${name}" (no config.yaml in ${home}). Not registering.`);
    process.exit(1);
  }
```

- [ ] **Step 4: Make `prompt()` EOF-safe in `setup.ts`**

In `setup.ts` `prompt()`, resolve on stream close so a piped/EOF stdin doesn't hang the wizard half-way:

```ts
function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
    rl.on("close", () => resolve(defaultValue || ""));
  });
}
```

- [ ] **Step 5: Run test + manual EOF check**

Run: `cd packages/hundredfold && pnpm test create-verify` → PASS.
Manual: `printf '' | node dist/bin/jinn.js create eoftest` (after build) must NOT print "created successfully" with an empty home; clean up with `jinn nuke eoftest`.

- [ ] **Step 6: Commit**

```bash
git add packages/hundredfold/src/cli/create.ts packages/hundredfold/src/cli/setup.ts packages/hundredfold/src/cli/__tests__/create-verify.test.ts
git commit -m "fix(cli): verify setup populated home before declaring create success; EOF-safe prompt"
```

---

## Task 6: Rewrite the onboarding skill (gamified playbook)

**Files:**
- Rewrite: `packages/hundredfold/template/skills/onboarding/SKILL.md`

**Interfaces:** none (Markdown playbook the COO follows; acceptance is the E2E run in Task 10).

- [ ] **Step 1: Replace the skill content**

Write the full playbook (generic placeholders, instance-safe paths):

````markdown
---
name: onboarding
description: Walk a new user through a warm, game-like first-run setup of {{portalName}} — get to know them, hatch their first employee, demo delegation, and create their first cron. Every step is skippable.
---

# Onboarding Skill

## When this runs
On a fresh install (`portal.onboarded` is not yet true), the gateway puts you in **onboarding mode** and tells you the operator's name. Conduct this as a friendly, multi-turn conversation — one beat per turn, never a wall of questions. Speak in the **second person**. You already know their name; never ask for it.

**Every beat must offer a skip** — e.g. "(or say 'skip' / 'later' and we'll move on)". If they skip, move to the next beat gracefully.

## Beats

### 1. Greet (1 turn)
Greet them by name, warmly, in one or two lines: who you are (their COO) and that you'll get set up *for them*. Then go to beat 2.
> e.g. "Hey {{operatorName}} 👋 I'm {{portalName}}, your COO. Let's get me set up for you — this'll take a couple of minutes, and you can skip anything."

### 2. Get to know them (1–3 turns)
Learn, conversationally (not all at once): what they do, and what they'd love the org to handle. Ask one proactive follow-up if it helps. As you learn, **write/update**:
- `knowledge/user-profile.md` (name, role, business, goals)
- `knowledge/preferences.md` (verbosity, tone, emoji, language)
- `knowledge/projects.md` (anything they're working on)

### 3. Hatch their first employee (centerpiece)
Propose ONE tailored hire based on what they told you — name, role, emoji, department — and ask if they like it or want changes. On agreement, **really create it** using the `management` skill (write the employee YAML under `org/<department>/<name>.yaml`). Then **scaffold a starter skill** for that hire using the `skill-creator` skill (a small, relevant playbook) and reference it in the new employee's persona. Confirm: "Done — {{newEmployee}} is now part of your team."

### 4. Show delegation live
Tell them you'll show how delegation works, then **spawn a child session** to the new hire with a tiny real first task (`POST /api/sessions` with `employee: <name>` and `parentSessionId: <this session>`). Narrate it: "Watch the left sidebar — {{newEmployee}}'s session just appeared. I delegated a task; they'll report back to me and I'll summarize." When they report back, summarize for the operator.

### 5. First cron (skippable)
Ask if there's anything recurring they'd like handled automatically (a weekly summary, a daily check, etc.). If yes, create a real cron job via the `cron-manager` skill, routed through you (the COO). If no/skip, move on.

### 6. Wrap
Recap what's set up (employee, skill, any cron), point them to where things live (Organization, Cron, Chat), and **set `portal.onboarded: true` in `config.yaml`** so onboarding never repeats. Invite their first real task.

## Notes
- Use instance-safe paths (`~/.{{portalSlug}}` or `$JINN_HOME`), not a hardcoded `~/.jinn`.
- Keep turns short and human. This should feel like meeting a capable new teammate, not filling a form.
````

- [ ] **Step 2: Leak-grep the staged template change**

Run: `cd packages/hundredfold && pnpm test privacy-guard` — the repo's privacy-guard test scans `template/` (and `docs/`, `src/`) for blocked private names and personal paths; it MUST pass. Also eyeball the staged `SKILL.md` for any real personal names or absolute home paths.
Expected: privacy-guard test passes.

- [ ] **Step 3: Commit**

```bash
git add packages/hundredfold/template/skills/onboarding/SKILL.md
git commit -m "feat(onboarding): gamified multi-beat setup skill (hatch employee, demo delegation, first cron)"
```

---

## Task 7: Wizard — genie icon, engine/model/effort step, launch-into-chat

**Files:**
- Modify: `packages/web/src/components/onboarding-wizard.tsx`
- Modify: `packages/web/src/lib/api.ts` (`completeOnboarding` signature)

**Interfaces:**
- Consumes: `api.getModels()` registry already exposed via config; `api.createSession(params)`; `api.completeOnboarding({...engine,model,effortLevel})`.
- Produces: a 5-step wizard whose completion persists engine/model/effort and routes to `/chat?sessionId=<new COO session>`.

- [ ] **Step 1: Extend the api client `completeOnboarding`**

In `web/src/lib/api.ts` (~346):

```ts
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string; engine?: string; model?: string; effortLevel?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
```

- [ ] **Step 2: Genie icon on the welcome step**

In `onboarding-wizard.tsx`, replace the welcome-step robot logo (the `🤖`/robot graphic in step 0) with a genie `🧞`. (Keep the same container/markup; swap only the glyph/illustration.)

- [ ] **Step 3: Add the engine/model/effort step + bump `TOTAL_STEPS`**

Set `const TOTAL_STEPS = 5`. Add local state and a new step rendered before the final overview step:

```tsx
const [engineChoice, setEngineChoice] = useState<{ engine: string; model: string; effortLevel?: string }>({
  engine: "claude", model: "opus", effortLevel: "medium",
})
const TIERS = [
  { label: "Smartest", model: "opus",            sub: "Opus 4.8 — deepest reasoning" },
  { label: "Balanced", model: "claude-sonnet-4-6", sub: "Sonnet 4.6 — fast & capable" },
  { label: "Fastest",  model: "claude-haiku-4-5",  sub: "Haiku 4.5 — quickest, lightest" },
]
// Step N (engine): render TIERS as selectable cards; on select →
//   setEngineChoice({ engine: "claude", model: tier.model, effortLevel: "medium" })
// Plus an "Advanced" <details> exposing engine (claude/codex/grok) + model + effort
//   read from the config models registry (api.getConfig().models).
```

(The three tier cards write the **default-engine** model; the Advanced disclosure allows switching engine/model/effort. Pixel styling is finalized in Task 9.)

- [ ] **Step 4: Persist engine choice on complete + launch the COO chat**

Update `handleNext`'s completion branch:

```ts
await api.completeOnboarding({
  portalName: localName || undefined,
  operatorName: localOperator || undefined,
  language: localLanguage || undefined,
  engine: engineChoice.engine,
  model: engineChoice.model,
  effortLevel: engineChoice.effortLevel,
})
if (!forceOpen) localStorage.setItem("jinn-onboarded", "true")
setVisible(false)
onClose?.()
// Launch the live COO setup conversation (employee omitted = COO).
try {
  const seed = `Hi! I just finished setup — let's get started. 👋`
  const session = await api.createSession({
    message: seed,
    engine: engineChoice.engine,
    model: engineChoice.model,
    effortLevel: engineChoice.effortLevel,
  }) as { id?: string }
  if (session?.id) { navigate(`/chat?sessionId=${session.id}`); return }
} catch { /* fall through to home */ }
navigate("/")
```

- [ ] **Step 5: Build + manual walkthrough**

`pnpm build`; on a throwaway instance: wizard shows 5 steps (genie welcome → name/lang → theme → accent → engine), completes, lands in a COO chat where the genie greets by the operator's name in second person and starts the beats. Confirm `config.yaml` has the chosen engine default.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/onboarding-wizard.tsx packages/web/src/lib/api.ts
git commit -m "feat(wizard): genie icon, engine/model/effort step, auto-launch COO setup chat"
```

---

## Task 8: `/chat` default filter "all"

**Files:**
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx` (952, 991)

**Interfaces:**
- Produces: sidebar defaults to "all"; an explicit prior choice (either value) still wins via localStorage.

- [ ] **Step 1: Change the default**

Line ~952:

```ts
  const [focusMode, setFocusMode] = useState<FocusMode>("all")
```

- [ ] **Step 2: Honor a stored choice both ways**

Replace the rehydration at ~991:

```ts
      const stored = localStorage.getItem(FOCUS_MODE_STORAGE_KEY)
      if (stored === "focused" || stored === "all") setFocusMode(stored)
```

- [ ] **Step 3: Build + manual verify**

`pnpm build`; fresh browser/origin → `/chat` opens on **All**; pick "Focused", reload → stays Focused.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/chat/chat-sidebar.tsx
git commit -m "feat(chat): default sidebar filter to All so delegated sessions are visible"
```

---

## Task 9: jinn-designer visual refresh of the wizard

**Files:**
- Modify: `packages/web/src/components/onboarding-wizard.tsx` (styling only)

**Interfaces:** none (visual). Functional structure from Task 7 must not regress.

- [ ] **Step 1: Delegate to jinn-designer**

Brief jinn-designer: restyle the 5-step wizard to match the recent `/chat` redesign — frosted material, tonal layering, spacing, the genie motif, and a polished engine-tier step. Inputs: this plan + `onboarding-wizard.tsx` + the `/chat` components for reference. Constraint: keep all step logic, `TOTAL_STEPS`, state, and the launch-into-chat behavior intact; styling only.

- [ ] **Step 2: Build + visual review**

`pnpm build`; screenshot each step on a throwaway instance; confirm it visually belongs next to `/chat`.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/onboarding-wizard.tsx
git commit -m "style(wizard): restyle onboarding wizard to match /chat redesign"
```

---

## Task 10: End-to-end acceptance on a throwaway instance

**Files:** none (verification).

- [ ] **Step 1: Fresh instance**

From a worktree build, create `~/.test-onboarding` on port 7788 (host `0.0.0.0` if Tailscale access wanted), `onboarded:false`.

- [ ] **Step 2: Run the full path and verify acceptance (spec §7)**

- [ ] Wizard shows on first load (employee present, 0 sessions).
- [ ] Completing it sets global engine/model/effort and opens a COO chat.
- [ ] Genie greets by name, second person; never re-asks the name; never third-persons the operator.
- [ ] Genie hatches a real employee (YAML on disk + visible in Organization), scaffolds a skill, spawns a **visible** child session (sidebar on "All"), and creates a real cron — each skippable.
- [ ] `/chat` opens on "All"; a previously-chosen "Focused" still loads as focused.
- [ ] `jinn create` with EOF/interrupted setup does not report success or register a half-built instance.
- [ ] Engine selectors are driven by the config `models` registry (no hardcoded list beyond the three default-engine tiers).

- [ ] **Step 3: Teardown**

Nuke the throwaway instance + remove the worktree. Confirm live `~/.jinn` / 7777 untouched and `~/.jinn/instances.json` pristine.

---

## Self-Review

- **Spec coverage:** gate fix (T1) ✓; second-person identity (T2) ✓; onboarding context + auto-launch trigger (T3, T7) ✓; engine/model/effort default (T4, T7) ✓; create hardening (T5) ✓; gamified skill incl. employee+skill, child-session demo, cron (T6) ✓; genie icon (T7) ✓; visual refresh (T9) ✓; `/chat` "all" (T8) ✓; idempotency via `onboarded` (T3, T6) ✓; acceptance (T10) ✓.
- **Placeholders:** none — code shown for every code step; visual styling (T9) is intentionally delegated with explicit constraints.
- **Type consistency:** `buildIdentity` / `buildOnboardingContext` signatures match between definition and tests; `completeOnboarding` body fields match between web client (T7), gateway handler (T4); `instanceHomeIsPopulated` matches between create.ts and its test; `engineChoice` shape matches the createSession/completeOnboarding payloads.

> **As-built (2026-06-17):** shipped with a two-flag model (`onboarded`=wizard, `setupComplete`=conversation), a registry-driven engine step (Advanced multi-engine switch + per-model effort deferred; effort fixed at `medium`), and a "complete actions in-turn" rule in the onboarding skill. See the spec's *As-built deltas* section.
