# Web UI: HeroUI and the Marid Aero identity

Status: proposal for approval. Nothing here changes the shipped UI until the
slices below are approved and merged one by one.

Goal: move the web UI onto [HeroUI v3](https://heroui.com) piece by piece,
and give Marid a visual identity of its own: translucent glass, soft depth,
light and glossy highlights ("Aero"), legible and accessible in light and
dark.

A working prototype of both halves (HeroUI wired in through a token bridge,
the glass identity on the real shell, chat, board, Todo and settings screens)
is in the prototype pull request (#165, not for merge), with before/after
sheets attached in the format every slice will use.

---

## 1. Audit of the current web UI

**Stack.** `packages/web` is React 19 + Vite 7 + React Router 7 + TanStack
Query 5, styled with **Tailwind CSS 4.1** (CSS-first, `@tailwindcss/postcss`).
Primitives are shadcn-style ("new-york") wrappers over the `radix-ui` package,
plus `cmdk`, `lucide-react` icons, `class-variance-authority` and
`tailwind-merge`. Heavy, already lazy islands: TipTap (Todo body editor),
xterm (terminal), XYFlow + dagre (org map), react-syntax-highlighter.

**Styling approach.** Almost everything reads raw design tokens through
arbitrary values: about **4,000 `[var(--…)]` classes across 242 files**, 306
inline `style={{}}`, only three `cva()` recipes. The tokens live in
`src/routes/globals.css` (1,562 lines: Apple-HIG fluid type scale bound to a
Text size setting, 4px spacing, durations, easing, "material" tints, shadows)
and are recoloured by `src/routes/theme-overrides.css` (the current sea-teal
palette). This is the main lever for the identity: redefining the shared
tokens restyles every screen without touching 242 files.

**Theming.** `data-theme` on `<html>` (`dark` | `light` | `system`), resolved
before first paint by an inline script in `index.html`, then kept by
`ThemeProvider` (`src/routes/providers.tsx`). A user accent colour is written
inline on `<html>` (`use-root-css-variables.ts`); Text size scales every type
step. Four token blocks per palette (dark, light, system-light, system-dark).

**Shell.** `PageLayout` (`components/page-layout.tsx`) composes the desktop
icon rail (`NavRibbon`, `pill-nav.tsx`), the routed content, `StatusBar` and
the mobile `MobileTabBar`; chat renders the rail itself beside its list
(`routes/chat/page.tsx`, `components/chat/chat-sidebar.tsx`). Floating header
pills already use a frosted material (`--pill-bg`, `backdrop-filter`), with an
opaque fallback for coarse pointers.

**Routes.** 23, all lazy: chat (`/`), Todos board and Todo page, cron, notes,
logs, limits, auto-dispatch, org map, settings (+ plugins), skills, file
viewer, more, the Talk orb harness, a dev-only redesign mockup, and plugin
pages.

**Primitive inventory** (`src/components/ui`, 26 files; importers in
brackets): dropdown-menu (Radix, 18), employee-avatar (24), dialog (Radix,
11), button (5), employee-chip (5), skeleton (4), dialog-actions (4),
image-lightbox (3), context-menu (2), select (2), switch (1, plus the
Settings `ToggleSwitch` used 22 times), textarea (2), option-pills (2),
emoji-picker (2), tooltip (1), tabs (1), scroll-area (1), input (1), badge
(1), card (1), quiet-card (1), command (cmdk, unused) and a few media
helpers. Radix is used directly in two more files (a HoverCard in
`todo-mention.tsx`, a Dialog in `todos/todo-dialog.tsx`).

**What HeroUI changes.**

- HeroUI v3 (3.2.6) is Tailwind-4-native and CSS-first: no provider, no
  framer-motion. Components are compound React Aria Components with BEM-ish
  classes and CSS variables. Tailwind stays; nothing in the build changes.
- New dependencies: `@heroui/react`, `@heroui/styles`, and React Aria peers
  (`react-aria-components`, `react-aria`, `@react-aria/utils`,
  `@react-aria/ssr`, `@internationalized/date`). Radix and cmdk go once the
  last primitive moves.
- Bundle, measured on the prototype against main: initial JS 187,673 →
  187,683 B gzip (unchanged; HeroUI is only on the lazy Settings route); entry
  CSS 30.3 → 33.5 KB gzip (HeroUI theme, utilities, Switch CSS and the glass
  tokens); the first HeroUI component on a route brings React Aria's
  foundation, about **28 KB gzip**, which later components share. Radix's menu
  code is already in the initial chunk today, so moving the dropdown offsets
  part of that when it lands.
- The initial-path budget (`perf-budgets.json`, 195,000 B) has about 7 KB of
  headroom. Any HeroUI control in the always-loaded shell moves React Aria
  into the initial path. See risks.

**Collisions found by the prototype** (each is fixed there and becomes part
of slice 1):

| Collision | Effect | Resolution |
|---|---|---|
| HeroUI `@utility focus-ring` (always-on ring) vs Marid's `.focus-ring` class (focus-visible outline, 109 uses) | every card and button drew a 2px accent ring | rename Marid's class to `focus-outline` |
| `--color-accent` / `--color-muted`: shadcn meaning (hover fill) vs HeroUI meaning (brand colour, muted text) | 44 Marid call sites would change colour | HeroUI's vocabulary wins; the 44 call sites move to `[var(--fill-*)]` / `[var(--text-primary)]` |
| HeroUI's `dark` variant falls back to `prefers-color-scheme` even when the app is set to light | `dark:` styles on a light page under a dark OS | do not import HeroUI's variants file; keep Marid's `dark` variant |
| Radius scale (`--radius-sm…xl`) | small shifts | HeroUI derives radii from `--radius`; the bridge sets it and the identity sets the scale |
| HeroUI `base.css` sets every element's border colour to `--border` | unstyled borders pick up the separator colour | wanted; bridged to `--separator` |
| `@heroui/styles` exports its theme files under a two-wildcard pattern resolvers reject | build error | import that one file by path |
| React Aria overlays sit at `z-index: 100000` | above Marid's `z-50`/`z-[100]` layers | audit in the overlay slices |

---

## 2. Visual identity: Marid Aero

**Direction.** Jinn's look is warm charcoal and amber over a flat tonal
staircase, set in Hanken Grotesk. Marid today is that same structure
recoloured teal. Aero changes the structure, not just the hue: a luminous
ambient backdrop (sky over shallow water by day, light through deep water at
night) with the interface floating on it as glass: translucent chrome, a
near-opaque reading sheet, lit edges and a soft specular highlight. Mood
references: Windows 7 Aero title bars, "Frutiger Aero" (sky, water, gloss),
macOS sidebar vibrancy, visionOS glass materials (glass for chrome, solid
ground for reading).

Mockups: the identity board is attached to this plan's pull request (#164);
the prototype's before/after sheets are on #165.

**Palette** (accent / info / success / highlight / danger / text):

| | Aqua | Sky | Lagoon | Iris | Coral | Ink / Foam |
|---|---|---|---|---|---|---|
| Light | `#06659F` | `#1F6FD1` | `#13804F` | `#7A4FC4` | `#C4323E` | `#0C1A2B` |
| Dark | `#62C6FF` | `#6AB0FF` | `#5FD69A` | `#C3A2FF` | `#FF7A82` | `#E8F1FB` |

Ambient backdrop: four soft radial pools (aqua, iris, lagoon, sky) over a
vertical gradient (`#EAF5FE → #D9E9F7` light, `#07111E → #0A1728` dark).

**Glass tokens** (new), weakest to strongest:

| Token | Light | Dark | Blur | Used for |
|---|---|---|---|---|
| `--glass-chrome` | white 52% | navy 50% | none | rail, chat list, side panels: they sit on the static backdrop |
| `--glass-float` | white 64% | navy 62% | `--glass-blur` 22px, saturate 180% | header pills, composer, tab bar: they float over moving content |
| `--glass-overlay` | white 80% | navy 82% | `--glass-blur-strong` 32px | menus, popovers, dialogs |
| `--glass-sheet` | white 90% | navy 92% | none | where content is read |

Each has an `-opaque` twin (the tint composited at alpha 1). Every glass
surface gets `--glass-edge` (a 1px lit border), `--glass-specular` (an inset
top highlight) and optionally `--glass-sheen` (a top-down gloss gradient).

**Elevation.** Four steps, all from the same shadow colour: flat, card
(`--shadow-card`: edge + 1px + 24px soft shadow + specular), float
(`--shadow-key`), overlay (`--shadow-overlay`: edge + 24px + 64px).

**Token form.** Colours are written once with `light-dark()` and the root's
`color-scheme` picks the side, replacing four copies of every palette with
one. Gradients and shadow geometry keep a block per theme. Existing token
names (`--bg`, `--material-*`, `--fill-*`, `--text-*`, `--accent`,
`--pill-bg`, `--sidebar-bg` …) are kept and re-pointed at the glass tokens,
so untouched screens follow automatically.

**Typography.** UI and display in **Figtree** (variable 300–900, SIL OFL,
self-hosted, 20 KB latin), replacing Hanken Grotesk; code stays IBM Plex
Mono. The fluid HIG scale and the Text size setting are unchanged; titles
move to weight 700.

**Iconography.** Keep `lucide-react` (HeroUI v3 is icon-agnostic) at a 1.75
stroke; the active rail item sits on an accent-tinted glass chip.

**Motion.** Keep the duration tokens and reduced-motion collapse. Glass
surfaces enter with opacity + 4px rise + 0.98→1 scale on `--ease-spring`;
exits are quicker. Blur radius is never animated and the sheen never
shimmers. HeroUI's transitions already honour `motion-reduce`.

**Logo and wordmark.** A glass app mark (`docs/design/marid-aero/mark.svg`):
a rounded tile in a sky-to-sea gradient with a lagoon caustic glow, a white
"M" drawn as a wave, a top gloss and a lit rim. Wordmark "Marid" in Figtree
700 at -0.02em. The mark becomes the default rail mark, favicon and PWA
icons; an operator's own portal emoji or icon still wins.

**Accessibility.**

- Text never sits on blur. Reading happens on the near-opaque sheet; chrome
  carries only short labels.
- Contrast is checked at the worst case: each text token over each glass tint
  composited on every backdrop stop. Prototype values (WCAG ratio, minimum
  over all stops):

  | | primary | secondary | tertiary | accent text |
  |---|---|---|---|---|
  | Light, chrome | 13.6 | 5.8 | 4.8 | 4.8 |
  | Light, sheet | 16.1 | 6.2 | 5.1 | 5.7 |
  | Dark, chrome | 12.2 | 7.4 | 5.2 | 7.3 |
  | Dark, sheet | 15.9 | 9.1 | 6.0 | 9.6 |

  Text on the accent: 6.2 (light), 8.5 (dark). Slice 2 turns this into a
  unit test so a token change cannot regress it.
- **Reduced transparency**: `prefers-reduced-transparency: reduce` and a
  `data-transparency="reduced"` attribute (written by a new Appearance
  setting, applied before first paint like Text size) swap every glass token
  for its opaque twin and switch blur off. Verified in the prototype.
- **Reduced motion**: existing duration collapse; HeroUI respects it.
- Focus rings stay visible on glass (accent ring with a 2px offset); React
  Aria brings keyboard and screen-reader behaviour for every migrated
  control.

---

## 3. Migration strategy: piece by piece

**Coexistence.**

1. **One stylesheet root.** `src/routes/app.css` imports `globals.css`,
   HeroUI's theme map, utilities and base, then only the component CSS in
   use, then the Marid palette, identity and bridge. One Tailwind compile, so
   HeroUI's `@apply`s resolve against Marid's theme. `main.tsx` imports only
   this file.
2. **Token bridge** (`heroui-bridge.css`). HeroUI's default theme is not
   imported. Every variable its components read (`--background`, `--surface`,
   `--overlay`, `--default`, `--field-*`, `--success` … and the derived
   hovers and soft tints) is defined from Marid tokens. A HeroUI control and
   a legacy control side by side share one palette, and theme or accent
   changes move both.
3. **Adapters, not call-site churn.** App code keeps importing
   `@/components/ui/*`. A primitive slice swaps that file's internals to
   HeroUI behind its existing props (the prototype does this for the
   Settings `ToggleSwitch`). Only `components/ui` imports `@heroui/react`,
   always by deep path (`@heroui/react/switch`) so each route carries only
   what it uses; a lint rule enforces both.
4. **No provider** is needed for HeroUI v3. One React Aria `RouterProvider`
   (wired to React Router's `navigate`) is added so HeroUI links and menu
   items navigate client-side.
5. **Identity is tokens plus a few shell attributes** (`data-shell="root" |
   "sheet" | "panel"`), so it can ship and revert independently of the
   component work.

**Order.** Foundation, then identity and shell, then primitives (controls
before overlays), then screens, then cleanup. Each slice is one pull request,
shippable alone and revertable with a single revert. The ordered list, with
sizes and tiers, is in section 6.

**Upstream.** `globals.css` has been kept untouched so upstream merges stay
clean. This migration ends that: the collisions above need edits there, and
the web UI will diverge from upstream for good. Porting upstream web changes
becomes a reimplementation rather than a merge.

---

## 4. Before/after evidence for every pull request

`scripts/capture-ui.sh` and `e2e/ui-capture/` (README there) give every
slice the same method:

- a throwaway sandbox gateway on its own port and temporary home, seeded with
  neutral fixtures (one markdown chat, six Todos across the board);
- each affected screen in light and dark, desktop 1440×900 and narrow
  390×844, at 2× density with reduced motion;
- a leak check that fails a capture showing the sandbox token or anything
  shaped like an id;
- `sheet.mjs` pairs before and after into one sheet per screen;
- `gh pr edit <PR> --attach './shots/sheets/<screen>.png#<Screen>: before and
  after, light and dark, desktop and narrow'`.

"Before" comes from a built worktree of main (`JINN_CAPTURE_REPO`), "after"
from the branch. A slice that touches a screen not yet listed adds it to
`screens.mjs` in the same pull request. Shots never go into the repository.

---

## 5. Risks, performance and testing

**Risks.**

| Risk | Mitigation |
|---|---|
| Initial-path JS budget (about 7 KB headroom) cannot absorb React Aria's ~28 KB once a shell control (rail tooltip, header menu) is HeroUI | keep overlays lazy where possible; measure Radix removal as it lands; **decision needed**: accept raising the initial budget by up to ~25 KB when the overlay slices reach the shell |
| Permanent divergence from upstream's web UI | **decision needed**: accept it |
| Test churn: React Aria uses a native `checked` input (`role="switch"`), `data-selected` / `data-open` instead of Radix `data-state` (28 `data-[state=…]` selectors today) | each primitive slice updates its tests; the prototype's single swap broke 4 tests in 3 files, all `aria-checked` assertions |
| Overlay behaviour (focus return, portals, z-index 100000, nested menus, typeahead) | overlays split into four slices; the dropdown slice gets the most scrutiny |
| `light-dark()` needs Chrome 123, Safari 17.5, Firefox 120 | acceptable for a modern web app; if an older embedded WebView must be supported, slice 1 generates per-theme blocks instead |
| New UI face changes metrics (truncation, wrapping) | every screen pass reviews its sheet at narrow width |
| A user accent colour is not contrast-checked | unchanged from today; out of scope |
| Headless Chromium has hung on the app on some hosts | captures default to Firefox; tracked separately |

**Performance: `backdrop-filter`.** A blurred surface makes the compositor
re-sample everything behind it on every frame that content moves, at a cost
that grows with area and radius, and nested blur multiplies it. The rules:

- blur only where content moves behind a surface (floats and overlays);
  chrome and panels over the static backdrop are tint only;
- at most three blurred surfaces on screen at once; radius at most 32px;
- never on list rows or cards inside a scroller; never animate the radius;
- coarse pointers keep the existing opaque fallback for bars
  (`--pill-bg-opaque` pattern) and reduced transparency removes blur;
- slice 4 measures a transcript scroll (Chrome performance trace, 4× CPU
  throttle) before and after and records frame times in the pull request; a
  footgun check rejects raw `backdrop-blur` / `backdrop-filter` outside the
  glass tokens.

The prototype adds no blurred surface (it re-tints the existing frosted
pills), and its panels and sheet are unblurred.

**Testing.**

- *Unit:* a contrast test that parses the identity tokens and checks every
  text/surface pair at the worst backdrop stop (AA: 4.5 body, 3.0 large);
  adapter tests per migrated primitive (keyboard, focus, disabled, the
  existing props).
- *Existing suites:* each slice runs its touched tests while iterating and the
  full suite once before review; `perf:budget` stays a gate.
- *Visual:* the capture sheets on every pull request, reviewed by eye. No
  pixel-diff gate: fonts and rendering differ between hosts.
- *Accessibility:* add an axe pass (`@axe-core/playwright`) over the captured
  screens in slice 2.

---

## 6. Slices

Sizes: **S** one working session, **M** one or two, **L** split further.
Risk is how much can break for users if the slice is wrong. Every slice
attaches before/after sheets.

| # | Slice | Depends on | Size | Risk |
|---|---|---|---|---|
| 0 | Capture tooling (this pull request) | — | done | — |
| 1 | Foundation: HeroUI + peers, `app.css` root, token bridge, `light-dark()` token form, collision renames, React Aria router; current look unchanged | — | M | high |
| 2 | Identity: Aero tokens, ambient backdrop, sheet and panel shell, Figtree, reduced transparency (CSS), contrast unit test, axe pass | 1 | M | medium |
| 3 | Transparency setting in Appearance, applied before first paint | 2 | S | low |
| 4 | Floating glass: header pills, composer, mobile tab bar, top scrim, status bar; blur rules, footgun check, scroll measurements | 2 | M | medium |
| 5 | Mark and wordmark: SVG mark, favicon, PWA icons, manifest and theme-color per theme, default rail mark | 2 | S | low |
| 6 | Primitives, controls: Button, Switch + ToggleSwitch, Input, Textarea, Badge (Chip), Skeleton, Tabs | 1 | M | medium |
| 7a | Overlays: Tooltip, Popover, the HoverCard in Todo mentions | 6 | S | medium |
| 7b | Overlays: DropdownMenu (18 importers), ContextMenu | 7a | M | high |
| 7c | Overlays: Select | 7a | S | low |
| 7d | Overlays: Dialog, image lightbox, the Todo dialog, sheets/drawers | 7a | M | high |
| 8 | Remove Radix, cmdk and Hanken Grotesk; budgets rebased | 7a–7d | S | low |
| 9a | Screen pass: chat (bubbles, code blocks, delegation cards, composer) | 2, 4, 6 | M | medium |
| 9b | Screen pass: Todos board and Todo page | 2, 6 | M | medium |
| 9c | Screen pass: org map nodes and editor | 2, 7d | S | low |
| 9d | Screen pass: settings, skills, cron, logs, limits, auto-dispatch, notes, more | 2, 6 | M | low |
| 9e | Screen pass: Talk orb palette, onboarding, sign-in, error pages | 2 | S | low |
| 10 | Cleanup: fold `theme-overrides.css` into the identity, drop unused tokens, docs and README screenshots | all | S | low |

Slices 3, 4, 5 and 6 can run in parallel once their dependency lands; the
screen passes can run in parallel with each other.
