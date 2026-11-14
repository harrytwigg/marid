# Onboarding Redesign — Design Spec

**Date:** 2026-06-17
**Status:** Approved design → ready for implementation plan
**Scope:** First-run onboarding for a fresh Hundredfold instance (web wizard + the live COO setup conversation that follows it).

> Names like "John" (operator) and "Hui" (portal/COO) below are illustrative
> examples of the configured `operatorName` / `portalName`, not literals.

---

## 1. Problem

Onboarding today is **better-built than it is reachable**, and the two halves don't connect.

1. **The web wizard never shows.** Visibility is gated on `needed`, computed in
   `gateway/api.ts` as `!onboarded && sessions.length === 0 && !hasEmployees`.
   `setup` always seeds `org/general/assistant.yaml`, so `hasEmployees` is
   always `true` → `needed` is always `false`. The polished 4-step wizard is
   dead-on-arrival. (Confirmed empirically: fresh instance, clean localStorage,
   0 sessions → no wizard.)

2. **The "setup conversation" is broken/impersonal.** A first-run onboarding
   instruction *does* exist — `buildEvolutionContext()` (context.ts) injects an
   "ONBOARDING MODE" block when `knowledge/user-profile.md` is near-empty — but:
   - It only fires **if the user happens to message the COO** (no auto-launch).
   - It is the flat "ask 4 questions at once, write 2 files, done" script.
   - It does **not** know the operator's name → re-asks for it.
   - `buildIdentity()` frames the operator as a third party: *"You are Hui, COO
     of **the user's** organization. You report to **John** (CEO)."* The model
     then says *"I help John run this"* (third person) and asks the
     person-it's-chatting-with for their name — even though that person **is** John.
   - It hardcodes `~/.hundredfold` paths (not instance-aware).

3. **`hundredfold create` can report false success.** When the interactive setup
   subprocess hits stdin EOF mid-prompt, `prompt()` never resolves, the process
   exits 0 with the home half-built, yet `create` prints "Instance created
   successfully" and registers the broken instance.

## 2. Goals / Success Criteria

- A brand-new user **always** sees the wizard on first load, then is **carried
  into a live, personal setup conversation** with the genie (no dead end, no
  manual "go chat with the COO" step).
- The genie **addresses the operator in second person** and **already knows
  their name** (from the wizard) — never re-asks it, never speaks about them in
  third person.
- The setup conversation is a **multi-turn, game-like, addictive** experience
  that, by doing (not telling), gets the user to:
  1. **Hatch their first employee** + scaffold a **starter skill** for them (real,
     persisted).
  2. See a **live child-session** from that new hire (delegation demo).
  3. Create their **first cron job**.
  Every beat offers a **Skip / "later"** so the user is never trapped.
- The wizard collects **engine / model / effort** and sets it as the **global
  default** (and the setup conversation runs on it).
- The wizard looks like it belongs next to the recent `/chat` redesign.
- `/chat` opens on the **"All"** filter by default so the child-session demo is
  visible in the sidebar.

**Out of scope (YAGNI):** quick-reply chips / special "hatch card" UI (decided:
pure conversation); multi-user/team onboarding; re-onboarding flows beyond a
manual "redo onboarding"; non-Claude engine-specific copy.

## 3. Architecture

**Server owns "onboarding mode"; the wizard auto-opens the conversation; the
genie ends onboarding.**

```
First load (onboarded:false)
   │
   ▼
Wizard shows  ──(Get Started)──►  completeOnboarding POST
   │  collects: portalName, operatorName, language,           persists prefs
   │            engine, model, effort                         + sets global
   │                                                          default engine/
   │                                                          model/effort
   ▼
Web creates a COO chat session + routes user into /chat
   │
   ▼
Gateway context builder sees onboarded:false
   → injects buildOnboardingContext() (operator-aware, 2nd person, the beats)
   │
   ▼
Genie runs the gamified beats (greet → understand → hatch employee+skill →
   live child-session demo → first cron → wrap)
   │
   ▼
Wrap step sets config.portal.onboarded = true  → never re-triggers
```

`config.portal.onboarded` is the **single source of truth** for onboarding
state — used by the API `needed` flag, the context builder's mode switch, and
the wrap-step completion.

*Rejected alternatives:* (B) skill-only with no auto-launch — the user might
never message the COO, so the discoverability gap remains; (C) gateway spawns
the session server-side on the POST — races with UI navigation and is heavier
plumbing for no benefit over the client opening it.

## 4. Design — six pieces

### 4.1 Wizard (web)
- **Gate fix:** rewrite `needed` to `!onboarded` only (drop `hasEmployees` and
  `sessions === 0`). `gateway/api.ts:1706`.
- **Genie icon:** replace the robot 🤖 logo on the welcome step with a genie 🧞.
- **New engine/model/effort step** (before the final "all set" step):
  plain-language framing — **Smartest / Balanced / Fastest** — with the concrete
  model name as subtext (e.g. "Smartest — Opus 4.8"). To keep a fresh user out of
  the weeds, the three tiers map to **models of the default engine** (whatever
  `engines.default` resolves to among installed engines — typically Claude:
  Smartest=Opus, Balanced=Sonnet, Fastest=Haiku), with effort defaulting to the
  model's middle `effortLevel`. A small **"Advanced"** disclosure lets power users
  switch engine (claude/codex/grok) and pick a specific model/effort. All options
  are read from the config `models` registry (no hardcoded list); effort choices
  are gated by each model's `effortLevels`. The selection writes the **global
  default**: `engines.default`, `engines.<engine>.model`,
  `engines.<engine>.effortLevel`.
- **Completion → launch:** after `completeOnboarding` succeeds, create a COO chat
  via the existing session API and `navigate` into it (instead of routing to a
  blank `/`).
- **Visual refresh:** restyle to match `/chat` (frosted material, tonal layers,
  spacing) — delegated to **hundredfold-designer** during build.

### 4.2 Identity / context fix (gateway)
- **`buildIdentity()`** (context.ts:378): second-person framing. Establish *"The
  person you are speaking with is {operatorName}. Address them directly (second
  person)."* Keep the CEO/relationship framing out of the conversational voice.
- **`buildOnboardingContext()`** — new function replacing `buildEvolutionContext`'s
  flat script. Takes `portalName`, `operatorName`, `language`. Drives the beats
  (below). Instance-path-safe (use `HUNDREDFOLD_HOME`/paths, not literal `~/.hundredfold`).
  Gate on `config.portal.onboarded === false` (not the profile-file heuristic).

### 4.3 Onboarding skill rewrite
- Rewrite `template/skills/onboarding/SKILL.md` into the gamified, multi-turn
  playbook. Beats, each **skippable** (genie offers "say 'skip' or 'later'"):
  1. **Greet personally** — "Hey John 👋 I'm Hui, your COO. Let's get me set up
     *for you*." Brief, warm, second person; never asks the name it already has.
  2. **Understand you** — proactive follow-ups about the operator's work and what
     they want the org to handle; writes `knowledge/user-profile.md`,
     `preferences.md`, `projects.md` as it goes.
  3. **Hatch first employee** — propose a tailored hire (name, role, emoji,
     department) from the operator's needs; tweak together; **really write the
     employee YAML** (via the `management` skill). Then **scaffold a starter
     skill** relevant to that hire (via `skill-creator`) — global playbook,
     referenced in the new employee's persona. (Employees have no `skills` field;
     skills are global and engine-discovered — see Note.)
  4. **Live child-session demo** — Hui **spawns a child session to the new hire**
     (existing delegation path: `POST /api/sessions` with `employee` +
     `parentSessionId`), gives it a tiny real first task, and narrates what's
     happening so John watches delegation work. With `/chat` on "All", the new
     hire's session appears in the sidebar live.
  5. **First cron** — ask whether John has anything recurring; if so, create a
     real cron job (via `cron-manager`).
  6. **Wrap** — recap what's set up, point to where things live, set
     `config.portal.onboarded = true`.
- Use `{{portalName}}` / `{{portalSlug}}` placeholders and instance-safe paths
  throughout (current template hardcodes `~/.hundredfold`).

### 4.4 hundredfold-designer visual refresh
- Wizard restyle to match `/chat`. Delegated to hundredfold-designer in implementation.
  Inputs: genie icon, the new 5-step structure, frosted/tonal styling.

### 4.5 Completion + idempotency
- Wrap sets `onboarded:true`; context builder stops injecting onboarding mode;
  wizard localStorage fast-path (`hundredfold-onboarded`) stays as the client cache.
- Provide a manual "redo onboarding" path later (clears the flag) — not required
  for v1.

### 4.6 `/chat` default filter
- `chat-sidebar.tsx:952`: default `focusMode` from `"focused"` → `"all"`.
- Reconcile the localStorage rehydration at `chat-sidebar.tsx:991` so an explicit
  prior choice still wins **both** ways (store/honor "focused" too), rather than
  only flipping to "all" when stored.

### 4.7 `hundredfold create` hardening (folded-in)
- After the setup subprocess returns, verify the instance home is actually
  populated (e.g. `config.yaml` exists) **before** registering the instance and
  printing success; make `prompt()` resolve on stdin `close`/EOF.
  Files: `cli/create.ts`, `cli/setup.ts`.

## 5. File-level change list (for the plan)

| Area | File | Change |
|------|------|--------|
| Gate | `packages/hundredfold/src/gateway/api.ts` (~1706) | `needed = !onboarded` |
| Identity | `packages/hundredfold/src/sessions/context.ts` (378) | second-person `buildIdentity` |
| Onboarding ctx | `packages/hundredfold/src/sessions/context.ts` (655) | replace with `buildOnboardingContext`, gate on `onboarded`, instance-safe paths |
| Skill | `packages/hundredfold/template/skills/onboarding/SKILL.md` | gamified multi-beat rewrite |
| Wizard logic | `packages/web/src/components/onboarding-wizard.tsx` | genie icon, engine/model/effort step, launch-into-chat on complete |
| Wizard visuals | (same) | hundredfold-designer restyle to `/chat` |
| Chat filter | `packages/web/src/components/chat/chat-sidebar.tsx` (952, 991) | default "all" + honor stored choice |
| Defaults persistence | `gateway/api.ts` completeOnboarding + `shared/config` | write engine/model/effort to config |
| create hardening | `packages/hundredfold/src/cli/create.ts`, `cli/setup.ts` | verify setup before success; EOF-safe prompt |

## 6. Note: "skills for the employee"

Employees have **no `skills` field**; skills are **global** Markdown playbooks the
engine auto-discovers (symlinked into `.claude/skills` / `.agents/skills`). So
"give the new hire a skill" = the genie **scaffolds a relevant starter skill**
(via `skill-creator`) that becomes available org-wide and is **referenced in the
new employee's persona**. This keeps the magic ("we built your first hire a
skill together") while staying true to the architecture.

## 7. Testing / acceptance

- Fresh instance (`onboarded:false`, employee present, 0 sessions) → wizard
  shows. (Regression guard for finding #1.)
- Completing the wizard sets global engine/model/effort and **opens a COO chat**.
- In that chat, the genie greets by name, second person, **never** re-asks the
  name, **never** third-persons the operator.
- Genie can hatch a real employee (YAML on disk + appears in org), scaffold a
  skill, spawn a visible child session, and create a real cron — each skippable.
- `/chat` opens on "All"; a previously-chosen "focused" still loads as focused.
- `hundredfold create` with interrupted/EOF setup does **not** report success or
  register a half-built instance.
- Engine selectors driven by the config `models` registry (no hardcoded list).

## 8. Implementation note

Build on a feature branch off `main`. Web visuals go through **hundredfold-designer**;
gateway/skill changes through **hundredfold-dev**. The live `~/.hundredfold` gateway (port
7777) and `~/.hundredfold` data must not be touched during development; validate on an
isolated throwaway instance (e.g. `~/.test-onboarding` on a non-7777 port).

---

## As-built deltas (post-implementation, 2026-06-17)

The implementation refined a few decisions from the design above:

- **Two flags, not one.** `portal.onboarded` gates the wizard (set by `completeOnboarding`). A separate `portal.setupComplete` gates the conversational setup context (`buildOnboardingContext`) and is set by the genie at the wrap beat. This split prevents the wizard finishing from prematurely suppressing the setup conversation (the single-flag model in §3 would have done exactly that). Both fields live on `PortalConfig`.
- **Engine step is registry-driven, Advanced disclosure deferred.** The wizard's engine step reads the resolved default engine + its model registry and offers that engine's models as tiers (plain-language "Smartest/Balanced/Fastest" eyebrow only for the known Claude trio). The multi-engine "Advanced" switcher (§4.1) was deferred; selection never hardcodes an engine and falls back to the server default if the registry is unavailable.
- **Effort fixed at `medium` for v1.** No per-model effort picker shipped; the wizard persists `effortLevel: "medium"`.
- **Onboarding skill has a "do the work in-turn" rule** added after E2E showed low-effort models announcing actions and yielding before completing a beat.
