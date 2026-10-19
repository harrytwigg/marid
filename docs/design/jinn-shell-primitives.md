# Jinn Shell primitives

Design spec. No product code. Base SHA `76be9932`.

This document is the contract PLA-191..195 implement against. Eight primitives, one section
each, in the same shape every time: **anatomy**, **states**, **breakpoint behaviour**, **tokens
consumed**, and a **named source** for anything borrowed. A slice implements from here without
asking a follow-up question: every size is a number with a unit, and every colour, radius,
shadow, easing and duration is a token that already exists — with exactly one exception, the
refresh spinner's rotation period, which §9 writes as a literal and justifies where it is used.

Four questions were left open by PLA-187's dispatch and blocked PLA-191/192 from starting.
§1 answers all four, one answer each, no hedging. §10 enumerates every place a borrowed idiom
collides with a settled Jinn rule and names the winner.

The grammar here is borrowed from Ionic, Konsta UI v5, Apple HIG and Material 3. **No package
is.** Nothing in PLA-187's tree adds a dependency on Ionic or Konsta; the citations exist so a
reader can check the source of an idea, not so a slice can install it.

Paths are repo-relative. `web/` abbreviates `packages/web/src/`. Expand that shorthand and
every path here resolves at the base SHA — every one of them, with no exception. Where a later
sentence names a file by its bare file name alone, that is a back-reference to the full path
given earlier, not a second citation.

Two authorities cited below are **not** files in this repository, and are therefore named rather
than pathed: **Jinn taste**, the shared standard the planner, implementer and verifier all read,
and the **Jinn design skill**, the workspace playbook in the Jinn home that settles the Shared
Visual Language and the editable-sheet contract. Neither is quotable by path from a checkout, so
every rule this document takes from either is quoted inline and verbatim instead. A reader who
has only this repository can still check every rule that binds a primitive here.

---

**The token floor. Consume it; do not extend it.** Every custom property named anywhere in this
document is declared in `web/routes/globals.css` at the base SHA. No primitive below invents a
token — where one is genuinely missing, §11 records the gap and hands it to PLA-191 rather than
naming a property that does not resolve.

| Token | Resolved | Where |
| --- | --- | --- |
| `--duration-instant` | `1ms` | `web/routes/globals.css:272` |
| `--duration-fast` | `120ms` | `web/routes/globals.css:273` |
| `--duration-base` | `180ms` | `web/routes/globals.css:274` |
| `--duration-slow` | `260ms` | `web/routes/globals.css:275` |
| `--ease-spring` | `cubic-bezier(0.34,1.56,0.64,1)` | `web/routes/globals.css:406` |
| `--ease-smooth` | `cubic-bezier(0.4,0,0.2,1)` | `web/routes/globals.css:407` |
| `--ease-snappy` | `cubic-bezier(0.2,0,0,1)` | `web/routes/globals.css:408` |
| `--radius-sm` … `--radius-2xl` | `6 / 10 / 14 / 18 / 24px` | `web/routes/globals.css:401-405` |
| `--space-1` … `--space-16` | `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64px` | `web/routes/globals.css:249-258` |
| `--safe-top`/`-bottom`/`-left`/`-right` | `env(safe-area-inset-*, 0px)` | `web/routes/globals.css:301-304` |
| `--keyboard-inset` | `0px`, written by the visual-viewport adapter | `web/routes/globals.css:309` |
| `--text-large-title` | `clamp(1.75rem, 1.5193rem + 0.9464vw, 2.125rem) × --text-scale` | `web/routes/globals.css:208` |
| `--text-title1` | `clamp(1.5rem, 1.3462rem + 0.6309vw, 1.75rem) × --text-scale` | `web/routes/globals.css:204` |
| `--scrim` | `rgba(0,0,0,0.32)` dark / `rgba(40,34,20,0.18)` light | `web/routes/globals.css:348, 430` |

Two consequences bind every section below.

**Author with the duration tokens, never a literal millisecond count.** The reduced-motion block
at `web/routes/globals.css:847-849` redefines `--duration-fast|base|slow` to `--duration-instant`,
so a token-driven animation collapses for free and a hardcoded one does not. `EdgeBackLayer`
already relies on exactly this: it *parses* `--duration-base` off the computed root style
(`web/components/edge-back/edge-back-layer.tsx`, `settleMs()`) so the CSS that runs the settle and
the navigation that waits for it cannot drift apart.

The rule holds for every animation that *finishes*. A continuous rotation is the one case where
collapsing the period to `--duration-instant` would make the animation worse rather than absent —
it would spin the glyph, not still it — so §9's spinner is authored as a literal and stands its
reduced-motion behaviour down explicitly instead. That is the only literal duration in this
document.

**Compose safe-area at the call site.** The convention already in the tree is
`pb-[max(var(--safe-bottom),6px)]`, not a second token wrapping the first.

---

## 1. The four open items, answered

### 1.1 Decision — `PageLayout`: **KEEP IT. `PageScaffold` composes *inside* it.**

Not renamed. Not replaced. Not deleted.

`web/components/page-layout.tsx` (184 lines) is the **app** shell and nothing else: the
`SearchOverlayProvider`, the Cmd-K palette, `NavRibbon`, `EdgeBackLayer`, `StatusBar`,
`MobileTabBar`, the live-stream widget, and the onboarding wizard. It renders no title, no
header, and no scroll container — every level of it is `overflow-hidden`, and its own docblock
says so: *"pages that want a heading render their own inline header (e.g. Todos)"* and *"each page
renders its own inline large-title header + top-right actions in content"*.

`PageScaffold` is the **page** shell: the thing 12 render sites across 12 files are each
hand-rolling today. Eleven of them repeat one identical `text-[length:var(--text-title1)] …
md:text-[length:var(--text-large-title)]` `<h1>` recipe — `web/routes/settings/page.tsx:264`,
`web/routes/experiments/page.tsx:72`, `web/routes/experiments/detail.tsx:140`,
`web/routes/skills/page.tsx:85`, `web/routes/skills/detail.tsx:181`,
`web/routes/cron/page.tsx:181`, `web/routes/cron/detail.tsx:159`,
`web/routes/limits/page.tsx:201`, `web/routes/more/page.tsx:134`,
`web/routes/settings/plugins/page.tsx:29`, and `web/routes/todos/board/board-switcher.tsx:58`.
The twelfth, `web/routes/workflow/list.tsx:111`, has already drifted
off it: that one jumps straight to `--text-large-title` with no `md:` step, so a phone renders
the desktop title size. That drift is the argument for the primitive, not a counterexample to
it — one hand-rolled recipe copied eleven times is what a twelfth copy diverges from.

So the composition is:

```
PageLayout                     app chrome — rail, tab bar, status bar, edge-back, overlays
└── PageScaffold               page chrome — header, scrollport, primary action
    └── <page content>
```

**Why keep rather than merge.** The two have different lifetimes and different cardinality.
`PageLayout` mounts once and must survive route changes — `EdgeBackLayer` photographs the outgoing
route a frame after it commits (`usePreviousViewSnapshot`), and a shell that remounted with the
route would have nothing to photograph. `PageScaffold` is per-route by definition. Merging them
would put the snapshot host inside the thing being snapshotted.

**What PLA-191 may change about `PageLayout`.** One thing only: the unused `headerActions` prop.
It is destructured as `_headerActions` and no caller supplies it — pages own their actions inline
via `ToolbarActions`. `PageScaffold` takes over that job properly, so the dead prop comes off the
signature in the same slice. Nothing else in the file is in scope.

### 1.2 Decision — FAB form factor: **icon-only 56px circle, persistent, mobile-only.**

Not the extended FAB. Not shrink-on-scroll.

- **Icon-only, not extended.** Material 3's extended FAB pairs the icon with a text label. On a
  page whose whole point is a large title, a labelled pill is a second piece of loud typography
  competing with the first. Jinn taste §2: *quiet beats loud; when in doubt, remove.* The icon
  carries the meaning; the `aria-label` carries it for assistive tech.
- **56px, which is Material 3's standard FAB.** Comfortably over both the Jinn ≥34px floor and
  HIG's 44pt, and it is a thumb target at the bottom of a phone (§10.4).
- **Persistent, not shrink-on-scroll.** Shrinking on scroll needs to know the scroll position.
  Doing that in JS is a scroll listener, which PLA-187 forbids; doing it in CSS burns the one
  scroll timeline the page has on decoration while §1.4 spends it on the header, which is the
  thing the reader actually navigates by. One moving part beats two.
- **Mobile-only.** Below `lg` the FAB is the page's primary action. At `lg` and up it does not
  render at all: the desktop header has room for a real labelled button in its trailing slot,
  and a circle floating over a 1440px page is a phone idiom stranded on a desktop.

*Source: Material 3 (FAB sizing, placement, elevation, extended-FAB variant). Colour roles and
elevation are Jinn's, not Material's — see §10.2 and §10.3.*

### 1.3 Decision — scrollport ownership: **`PageScaffold` owns the element; consumers receive it.**

`PageScaffold` renders exactly one scroll container and exposes that DOM node. It never calls
`scrollTo`, never restores a position, and never writes `scrollTop`. Reading and writing the
reader's position stays where it already is.

This is not a new contract. It is the contract the Todos list already runs on:

- `web/routes/todos/board/board-page.tsx` owns the scrolling `div` and holds its ref.
- `useBoardScroll` (`web/routes/todos/board/use-board-scroll.ts`) attaches `useScrollAnchor` to
  that ref and returns the `onScroll` handler the owner wires up.
- `TodoList` takes a `scrollRef` **prop** and hands it to
  `useTodoListVirtualizer(…, getScrollElement, scrollMargin)`, which is TanStack Virtual reading
  the same element (`web/routes/todos/list/list-virtualizer.ts`, `list-window.tsx`).

So a windowed list does not opt *out* of scaffold-owned scrolling. It opts *in*, by consuming the
element the scaffold already owns — exactly as it consumes `board-page`'s today. `PageScaffold`
exposes it two ways, both required:

1. a `scrollRef` render-prop / context value, for `useVirtualizer`'s `getScrollElement` and for
   `useScrollAnchor`; and
2. `data-scrollable` on the element itself, so it inherits
   `overscroll-behavior: contain; -webkit-overflow-scrolling: touch` from
   `web/routes/globals.css:1376` rather than re-declaring it.

**Ordering is a real hazard, and the scaffold must not make it worse.** `list-window.tsx` already
needs a `useState` round-trip because the scrollport is an *ancestor* whose ref attaches after the
subtree's layout effects run. `PageScaffold` therefore publishes the node through state, not
through a bare `useRef`, so a child's first layout effect either sees the real element or sees
`null` and re-runs — never a stale one.

**The escape hatch, and the one page that takes it.** `PageScaffold` accepts `scroll="external"`.
In that mode it renders the header and the children and creates **no** scroll box; the page owns
its own scrollers entirely. The Todos board takes it, for a reason that is structural rather than
stylistic: it keeps **two** scrollports permanently mounted, `listScrollRef` and `boardScrollRef`,
one of them `hidden`, so that a rotation between the mobile list and the desktop board does not
lose the reader's place (`web/routes/todos/board/board-page.tsx:671` and `:708`). A scaffold
offering one scroll slot cannot express that, and flattening it to one would be a regression
dressed as adoption.

`scroll="external"` costs the page its collapsing header — collapse requires the title to live
inside the scroller (§1.4), and in this mode there is no scroller to put it in. `LargeTitleHeader`
degrades to its inline state, which is what the board renders today anyway: a `flex-none` header
outside the scrolling region.

**What the scaffold must never do, stated as a prohibition because three writers already share
this element.** `useScrollAnchor`'s unkeyed `useLayoutEffect` restore, `useBoardScroll`'s POP
restore, and the virtualizer's own measurement corrections coexist only by careful ordering — the
`previous.scrollTop > 0` guard in `web/hooks/use-scroll-anchor.ts` exists specifically so the
anchor restore does not drag back the POP restore. A scaffold that also restored on route change
would be a fourth writer and would fight all three. It does not restore. Ever.

### 1.4 Decision — collapse mechanism: **`animation-timeline: scroll()`, CSS only.**

No scroll listener, no `IntersectionObserver`, no `useState` holding a collapsed flag. The header
is driven by the scrollport's own progress:

```css
@keyframes jinn-title-collapse {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(-6px) scale(0.92); }
}

.jinn-large-title {
  animation: jinn-title-collapse linear both;
  animation-timeline: scroll(nearest block);
  animation-range: 0 var(--jinn-collapse-distance);
}
```

`scroll(nearest block)` resolves to the scaffold's own scrollport, which is why §1.3 requires the
title to sit *inside* it.

`--jinn-collapse-distance` is the one custom property in this document that does **not** exist at
the base SHA. It is not a Ledger token and is not added to `globals.css`: the scaffold sets it
inline, per instance, from the large title's own rendered height (§11.2). Every other custom
property named anywhere in this spec resolves in `web/routes/globals.css` today. And the distance
is a *layout* measurement, not a scroll measurement, so reading it does not reintroduce the scroll
listener this decision exists to avoid.

**The fallback, and it is not a JS polyfill.**

```css
@supports not (animation-timeline: scroll()) {
  .jinn-large-title { display: none; }
  .jinn-inline-title { opacity: 1; }
}
```

Where the property is unsupported the header renders **permanently in its inline (collapsed)
state**: no large title, the inline title always visible, the material always applied. The page is
correct, quiet, and one line shorter. It is not animated, and nothing is animated badly.

This is deliberate. Reimplementing the collapse on a scroll listener for old engines is the exact
thing PLA-187 ruled out, and it would mean shipping two mechanisms whose behaviour diverges under
momentum scrolling — the worse outcome is the one where the fallback *almost* works. There are
currently zero occurrences of `animation-timeline`, `scroll-timeline`, `view-timeline` or
`@supports` anywhere in `packages/web`; this spec introduces the first of each.

**Reduced motion.** A scroll-driven animation is not time-driven, so the `--duration-*` collapse
at `web/routes/globals.css:847-849` does not reach it and neither does the global
`animation-duration: 0.01ms` reset. `LargeTitleHeader` therefore states its own contract: under
`prefers-reduced-motion: reduce`, the header takes the **same** permanently-inline state as the
unsupported fallback. Reader-driven or not, a title that changes size as the page moves is motion,
and a reader who asked for less of it gets none.

---

## 2. `PageScaffold`

The page shell. One per route, rendered as `PageLayout`'s child.

**Anatomy.** A column, `flex h-full min-h-0 flex-col`.

1. `LargeTitleHeader` (§3) — `flex-none` when `scroll="external"`, otherwise the first block
   *inside* the scrollport so the collapse timeline can reach it.
2. The scrollport — `min-h-0 flex-1 overflow-y-auto`, carrying `data-scrollable`. Owned here
   (§1.3), exposed as a node, never written to.
3. `PrimaryAction` (§4) — a sibling of the scrollport, not a child, so it does not scroll away.

Content padding is `px-[var(--space-3)] pt-[var(--space-5)] md:px-[var(--space-10)]`, and
`lg:pb-10` at `lg` and up. Below `lg` the bottom padding is computed, not a round number, because
it has to clear whatever actually floats over the scrollport — and the tab bar and the FAB float
over it at every width below `lg`, not just below `md`:

- **Tab bar only** — `calc(55px + max(var(--safe-bottom), 6px) + var(--space-4))`, the same
  expression `PrimaryAction` uses for its own offset (§4), and `calc(max(var(--safe-bottom), 6px)
  + var(--space-4))` when the scaffold is rendered with `hideMobileTabBar`.
- **With `PrimaryAction`** — that value plus `calc(56px + var(--space-4))`, the FAB's own height
  and one gap above it.

At a zero safe inset — the worst case, since `max(var(--safe-bottom), 6px)` only grows — and with
`--space-4` at its declared 16px (`web/routes/globals.css:252`), those resolve to **77px** with the
tab bar alone (55 + 6 + 16), **22px** under `hideMobileTabBar` (6 + 16), and **149px** with a
`PrimaryAction` (77 + 56 + 16). The FAB's own box spans 77px to
**133px** above the bottom edge, so 149px leaves exactly one `--space-4` gap between the last row
of content and the button. All three hold at every width from 320px to 1023px; none of them is a
flat number that stops tracking the chrome partway up that range.

`todo-list.tsx` ships `pb-24` today, and that is correct for a page with no FAB — 96px clears the
tab bar with room to spare. It is *not* enough once a FAB is present: 96px lands 37px short of the
FAB's 133px top edge, leaving the last 37px of a scrolled-to-bottom list sitting underneath it.
The scaffold knows whether it rendered a `PrimaryAction`, so it is the right place to spend the
extra padding only where it is owed.

**States.** `default` · `scroll="external"` (page owns its scrollers; §1.3) · `no header` (title
omitted; the scrollport becomes the whole box) · `empty` (the page's own empty state renders inside
the scrollport; the scaffold has no opinion) · `keyboard raised` (bottom padding grows by
`var(--keyboard-inset)`).

**Breakpoint behaviour. Two switches, at two different widths, and that is deliberate.**

*Measure switches at `md` (768px).* Horizontal and top padding are a measure concern: they answer
how wide the text column may run, and by 768px `--space-3` gutters leave text reading edge-to-edge.
This is the switch `web/routes/todos/list/todo-list.tsx:23` ships today —
`px-3 pb-24 pt-5 md:px-10 md:pb-10` — and the scaffold keeps its horizontal and top values, and
their `md` breakpoint, rather than moving a padding every Todos screenshot depends on.

*Chrome switches at `lg` (1024px), and bottom padding goes with it.* Chrome is a navigation
concern: `lg` is where `NavRibbon` appears and `MobileTabBar` stands down. Below `lg`,
`PrimaryAction` renders and the header may collapse. At `lg` and up, `PrimaryAction` does not
render — its action moves into the header's trailing slot — and the header is permanently expanded,
because a 900px-tall desktop viewport has room for the title and collapsing it buys nothing.
Bottom padding is not a measure concern at all: it exists only to clear the bar and the button, so
it is owed for exactly as long as they render, which makes `lg` its switch too. This is the one
value the scaffold deliberately does **not** inherit from `todo-list.tsx:23` — that file's
`md:pb-10` drops to 40px at 768px while the FAB still reaches 133px up, and the scaffold writes
`lg:pb-10` instead.

So between 768px and 1023px a page carries a desktop measure with mobile chrome: wide gutters, and
the full 149px (or 77px without a FAB) of bottom clearance the tab bar and the button still demand.
**That is the reading that survives**: the reader gets the wider column the moment the width
supports it, and keeps both the chrome and the room to scroll clear of it until the ribbon actually
replaces them. Neither number is a typo for the other, and no primitive below reads `md` and `lg`
as the same boundary. Verification viewports are 1440×900 and 390×844, both themes.

**Tokens.** `--space-3`, `--space-5`, `--space-10`, `--bg`, `--safe-top`, `--safe-bottom`,
`--keyboard-inset`.

*Source: Ionic (`IonPage`/`IonContent` — the page is a fixed-height column and exactly one
descendant scrolls). The `IonContent` shadow-DOM scroll host is not borrowed; Jinn exposes a plain
element so the existing anchoring and virtualization keep working against a node they can read.*

---

## 3. `LargeTitleHeader`

**Anatomy.** Two layers, not two boxes sharing one cell. A **sticky bar of constant height**
carries the inline title and the trailing slot; the **large title is a separate block in the
scroll flow beneath it**, and scrolls up under the bar. The two cross-fade as the reader scrolls.

**The collapsed header is the bar's height, and no animation is asked to make it so.** The large
title's box leaves by scrolling out of the scrollport, taking its own height with it. The opacity
and transform in §1.4's keyframes change what the title *looks* like on the way out, never what it
occupies — so the header's resting height is the bar's, at every point in the collapse. Stacking
both titles in one grid cell would size that cell to the large title forever and collapse to a
tall empty bar; that is the reason for two layers, and it is also why §2 places this whole header
inside the scrollport rather than above it.

- **Large title** — `--text-large-title` / `--weight-bold` / `--text-primary`, with
  `--text-large-title--line-height` and `--text-large-title--letter-spacing`. Leading-aligned to
  the page's content spine.
- **Inline title** — `--text-headline` / `--weight-semibold` / `--text-primary`. Leading-aligned
  on desktop; centred below `lg`, which is the iOS nav-bar idiom the mobile chat header already
  follows.
- **Trailing slot** — borderless icon buttons, transparent at rest, `--fill-secondary` on hover.
- **Optional subtitle / kicker** — `--text-footnote` / `--text-secondary`, large state only. It
  does not survive the collapse; a nav bar has room for one line.
- **The bar's own surface** — `--material-thick` plus `backdrop-blur`, `position: sticky`,
  `top: 0`, applied at *all* times, not switched on at a scroll threshold (§10.1).

**States.**

| State | Large title | Inline title | Bar surface |
| --- | --- | --- | --- |
| At rest, scrolled to top | `opacity: 1`, full scale | `opacity: 0` | `--material-thick`, nothing beneath it to blur |
| Mid-collapse | interpolating | interpolating | unchanged |
| Collapsed | `opacity: 0`, `scale(0.92)`, `translateY(-6px)` | `opacity: 1` | unchanged; content blurs beneath it |
| Unsupported / reduced motion | not rendered | `opacity: 1` | unchanged |
| `lg` and up | `opacity: 1`, permanent | not rendered | unchanged |

**Breakpoint behaviour.** Below `lg`: both states live, collapse is armed, inline title centred,
top padding `var(--space-3)`. That is breathing room only and deliberately carries **no**
`--safe-top`: `PageLayout` already pads every non-chromeless child by
`pt-[var(--safe-top)] lg:pt-0` (`web/components/page-layout.tsx:166`), so a second inset here
would clear the notch twice on a standard route — and §1.1 puts that line of `PageLayout` out of
scope, which leaves this header the side that has to yield. A `chromeless` host is the exception
and owns its own inset. At `lg` and up: large title only, no collapse, no sticky material needed
but kept for consistency of surface, leading-aligned.

**Tokens.** `--text-large-title`, `--text-large-title--line-height`,
`--text-large-title--letter-spacing`, `--text-headline`, `--text-headline--line-height`,
`--text-footnote`, `--weight-bold`, `--weight-semibold`, `--text-primary`, `--text-secondary`,
`--material-thick`, `--fill-secondary`, `--space-3`, `--space-4`, `--ease-smooth`,
`--font-ui`.

*Source: Ionic (`IonHeader collapse="condense"` — the large-title-to-nav-bar collapse, and the
rule that the large title scrolls with content while the bar stays). Apple HIG (large vs inline
nav-bar titles; the inline title is centred on iPhone). The **mechanism** is neither: Ionic drives
its collapse from a JS scroll callback, Jinn drives it from `animation-timeline: scroll()` (§1.4).
No 1px separator appears in any state (§10.1).*

---

## 4. `PrimaryAction`

The page's one most-likely action, as a floating circular button. Mobile only (§1.2).

**Anatomy.** A 56×56px circle. Background `--accent`, glyph `--accent-contrast` at 24px,
`--shadow-key`, `--radius-2xl` is too small at 24px so the shape is a true circle
(`border-radius: 50%`). No border, no ring, no icon label. `aria-label` is mandatory and is the
only place the action is named.

**Placement.** `position: absolute`, `right: var(--space-4)`, and
`bottom: calc(55px + max(var(--safe-bottom), 6px) + var(--space-4))`. That literal `55px` is
`MobileTabBar`'s box above its own safe-area padding — `min-h-[49px]` rows
(`web/components/chat/mobile-tab-bar.tsx:85`) plus `py-1.5`'s 6px top (same file, `:58`). It is a
literal because no token for the tab bar's height exists; §11 hands that gap to PLA-191, and the
FAB is its first consumer.

When the scaffold is rendered with `hideMobileTabBar` (the full-screen-push case — a pushed task
page owns the bottom edge), the offset drops to
`calc(max(var(--safe-bottom), 6px) + var(--space-4))`.

**States.** `rest` — `--accent` / `--shadow-key`. `hover` — no change; there is no hover on the
only breakpoint it renders at. `active` — `scale(0.94)`, `--duration-fast`, `--ease-snappy`.
`focus-visible` — a 2px `--accent` outline at 2px offset, the one ring in this document, because
a focus indicator is not chrome at rest. `disabled` — `--fill-tertiary` background,
`--text-quaternary` glyph, no shadow. `pressed-into-sheet` — when the action opens a `Sheet`, the
FAB stays put; it does not morph into the sheet.

**Breakpoint behaviour.** Renders below `lg`. Does not render at `lg` and up — the same action is
supplied to `LargeTitleHeader`'s trailing slot as a labelled button, `--fill-secondary` background,
`--text-primary` label at `--text-subheadline` / `--weight-medium`. One action, two form factors,
one call site.

**Tokens.** `--accent`, `--accent-contrast`, `--shadow-key`, `--fill-tertiary`,
`--fill-secondary`, `--text-quaternary`, `--text-primary`, `--text-subheadline`, `--weight-medium`,
`--space-4`, `--safe-bottom`, `--duration-fast`, `--ease-snappy`.

*Source: Material 3 (FAB — 56dp standard size, bottom-trailing placement, the extended variant we
declined). Colour roles are Ledger's `--accent` / `--accent-contrast`, not Material's
primary-container taxonomy (§10.3); depth is `--shadow-key`, not an elevation level (§10.2).*

---

## 5. `Sheet`

A bottom-anchored modal on mobile, a centred dialog on desktop. This primitive is largely a
**codification of what already ships**, not an invention: `web/routes/todos/todo-filter-sheet.tsx`
and `web/routes/todos/new-todo-dialog.tsx` are the reference implementations, and PLA-193 extracts
rather than redesigns.

**Anatomy.**

1. **Scrim** — `--scrim`, `--animate-overlay-in` / `--animate-overlay-out`. Tap to dismiss.
2. **Container** — `--bg-secondary`, `rounded-t-[var(--radius-2xl)]` on mobile,
   `--radius-xl` all round on desktop, `--shadow-overlay`. No border: `--shadow-overlay` carries
   the faint ~0.5px per-theme ring that stands in for one.
3. **Grabber** — a 36×4px `--fill-tertiary` pill, fully rounded (`border-radius: 9999px`, a
   shape rather than a design radius, so no Ledger token is implied), centred, mobile only.
4. **Header** — optional title at `--text-headline` / `--weight-semibold`, with a trailing
   borderless close button.
5. **Body** — `min-h-0 overflow-y-auto`, stamped `data-scrollable`.
6. **Footer** — optional, `flex-none`, padded `pb-[max(var(--safe-bottom),var(--space-2))]`.

**Detents.** Two, and only two. `medium` — `max-height: 82vh`, the value `todo-filter-sheet.tsx`
ships. `large` — `max-height: calc(100dvh - var(--space-6))`, which is `new-todo-dialog.tsx`'s
shape. A sheet declares one at mount. Dragging between detents is **not** in this spec: it needs a
second gesture recogniser alongside `useEdgeBackGesture`, and no page has asked for one.

**States.** `closed` · `entering` (`--animate-sheet-in` mobile, `--animate-pop-in` desktop) ·
`open` · `saving` (editable sheets only; dismissal has been requested and not yet granted — see
the contract below) · `exiting` (`--animate-sheet-out` / `--animate-pop-out`) · `keyboard raised`
(the body's bottom padding grows by `var(--keyboard-inset)`; the container does not move) ·
`scrolled body` (no shadow, no hairline appears under the header — §10.1).

All four enter/exit animations are wrapped in `motion-safe:`, as both reference implementations
already do.

**Editable sheets acknowledge revisions, not requests.** This is settled law in the Jinn design
skill, quoted verbatim: *"Persist item-scoped drafts before transport; serialize/coalesce saves
against the last acknowledged revision; a close may complete only when the latest local revision is
durably acknowledged. Browser history owns one reversible detail entry, while opaque transport IDs
stay out of URLs and rendered metadata."* PLA-193 extracts it with the visuals rather than leaving
each caller to re-derive it, which is what makes §5 a codification rather than a restyle. Four
obligations follow, and they bind any `Sheet` that edits something:

1. **The draft is persisted before transport.** The sheet writes its item-scoped draft — keyed by
   the edited item's own id, not by the sheet's — before it sends anything. A dropped connection, a
   reload, or a backgrounded tab loses no typing.
2. **Saves serialize and coalesce against the last acknowledged revision.** Writes do not overlap.
   Each carries the revision the server last acknowledged, and a newer local edit supersedes an
   in-flight one rather than racing it.
3. **A close completes only on acknowledgement.** Requesting dismissal moves the sheet to `saving`,
   not to `exiting`; `exiting` is reached from `saving` only once the latest local revision is
   durably acknowledged. On failure the sheet stays open and says what went wrong, because a
   dismissal that silently discards an unacknowledged edit is data loss wearing an animation.
4. **History owns exactly one reversible entry.** Opening pushes one entry; a back gesture (§8)
   pops it and closes the sheet; closing by scrim, close button or `Esc` consumes that same
   entry. Never two, never zero. Opaque transport ids stay out of the URL and out of rendered
   metadata.

A **read-only** `Sheet` — a filter panel, a picker — carries none of the four: it has no revision
to acknowledge and nothing to persist. That is the split between the two reference implementations
named above: `todo-filter-sheet.tsx` is the read-only case and `new-todo-dialog.tsx` the editable
one. The visual anatomy, detents and breakpoint behaviour in this section apply identically to
both.

**Breakpoint behaviour.** Below `sm` (640px): full-bleed bottom sheet, `inset-x-0 bottom-0`, top
corners `--radius-2xl`, grabber shown. At `sm` and up: centred, `w-[min(620px,calc(100vw-32px))]`,
all corners `--radius-xl`, no grabber, pop rather than slide.

**Tokens.** `--scrim`, `--bg-secondary`, `--radius-xl`, `--radius-2xl`, `--shadow-overlay`,
`--fill-tertiary`, `--text-headline`, `--weight-semibold`, `--text-primary`, `--space-2`,
`--space-5`, `--space-6`, `--safe-bottom`, `--keyboard-inset`, `--animate-sheet-in`,
`--animate-sheet-out`, `--animate-overlay-in`, `--animate-overlay-out`, `--animate-pop-in`,
`--animate-pop-out`.

*Source: Apple HIG (sheet detents; the grabber as the affordance that a sheet is draggable — we
render it as a size cue, and §5's detent note is explicit that dragging is not implemented).
Konsta UI v5 (iOS sheet-modal / Material bottom-sheet split by breakpoint).*

---

## 6. `SegmentedControl`

A small set of mutually exclusive views. Two to five segments; beyond that it is a menu.

**Anatomy.** A track — `--fill-tertiary`, `--radius-md`, 2px padding — holding equal-width
segments, with a thumb sliding beneath the active label. Thumb: `--bg-secondary`,
`--radius-sm`, `--shadow-subtle`, plus `--inset-shine`. Labels: `--text-subheadline`,
`--weight-medium`, `--text-secondary` at rest and `--text-primary` when active.

**Height is 34px**, which is the Jinn tap-target floor exactly (§10.4). Segments are equal
fractions of the track; a control with segments narrower than 34px has too many segments.

**States.** `rest` · `hover` (label steps to `--text-primary`; the track does not change) ·
`active/selected` (thumb beneath, label `--text-primary`) · `pressed` (`scale(0.97)` on the
pressed segment, `--duration-fast`) · `focus-visible` (2px `--accent` outline on the segment, not
the track) · `disabled` (labels `--text-quaternary`, no thumb movement).

**Motion.** The thumb translates on `transform` only, `--duration-fast` / `--ease-snappy`. It never
animates `width`; equal-width segments mean a translate is sufficient, and a width animation would
reflow the labels on every frame.

**Breakpoint behaviour.** Sized by its content at every breakpoint, with exactly one rule to the
contrary. **The trigger is role, not taste: below `sm` (640px), a control that is its page's
primary view switch — the one that changes what the scrollport shows — goes full-width
(`w-full`).** Every other segmented control keeps its content width at every width, including
below `sm`. Labels truncate with an ellipsis rather than wrapping in both cases, because a
two-line segment breaks the 34px height.

**Tokens.** `--fill-tertiary`, `--bg-secondary`, `--radius-sm`, `--radius-md`, `--shadow-subtle`,
`--inset-shine`, `--text-subheadline`, `--weight-medium`, `--text-primary`, `--text-secondary`,
`--text-quaternary`, `--accent`, `--duration-fast`, `--ease-snappy`.

*Source: Apple HIG (segmented control — equal widths, one active segment, the sliding thumb).
Konsta UI v5 (iOS segmented). Both draw a hairline around the track and around the thumb; Jinn
draws neither, and separates by fill and `--shadow-subtle` instead (§10.1).*

---

## 7. `ListSection`

A collection of rows. This primitive **reuses the settled Shared Visual Language and does not
redefine it** — the Jinn design skill's § "Shared Visual Language" is authoritative for the
grouped-inset grammar, and PLA-195 owns any update to it.

**Anatomy.** Quoting the settled rule: a collection is *ONE grouped-inset container
(`--bg-secondary` + `--shadow-card` + 5px pad, radius `--radius-xl`) with FLAT rows inside (inner
radius 13px, hover `--fill-quaternary`) — never a pile of per-row shadowed cards.*

The `13px` in that quote is not a free literal and is not a second radius token: it is the
container's own radius minus its pad, `calc(var(--radius-xl) - 5px)` — 18px less 5px — which is
the radius an inner corner has to take to stay concentric with the outer one. Author it as that
`calc`, so it tracks `--radius-xl` if the token ever moves.

- **Section header** — optional, *outside* the container, above it. Kicker voice: 11px mono
  semibold, `0.15em` uppercase, `--text-secondary` in both themes, `--font-code`.
- **Container** — as quoted above.
- **Row** — min-height 44px. Leading glyph centred in the first 16px; text on the spine at
  +30px, per the row-gutter law. Primary text `--text-body` / `--text-primary`; secondary
  `--text-footnote` / `--text-secondary`; trailing accessory (chevron, count, switch)
  `--text-tertiary`.
- **Footer caption** — optional, outside and below, `--text-footnote` / `--text-tertiary`.
- **No inter-row separators** (§10.1).
- **Never silently cap a list** — a true server total in the header and a quiet "Show N more" row,
  which is the same rule `web/routes/todos/list/list-virtualizer.ts` already models as a
  `show-more` virtual row.

**States.** `rest` · `hover` (row fill `--fill-quaternary`) · `pressed` (`--fill-tertiary`) ·
`selected` (`--fill-secondary`, matching the chat list's selected-row treatment) · `disabled`
(text `--text-quaternary`, no hover) · `empty` (one caption row inside the container, 36px tall — the
`EMPTY_SIZE` the windowed list already estimates in `web/routes/todos/list/list-virtualizer.ts` —
at `--text-tertiary`; the container still renders so the page does not jump when the first item
arrives) · `loading` (the container renders at its resting height with no rows).

**Breakpoint behaviour.** Below `md`: the container is inset by `--space-3` from the page edge.
At `md` and up: inset by `--space-10`, and its width is capped by the page's content measure rather
than growing to a 1440px line length. Rows keep the same 44px minimum at every breakpoint;
the trailing accessory hides below `sm` if the primary text would otherwise truncate.

**Tokens.** `--bg-secondary`, `--shadow-card`, `--radius-xl`, `--fill-secondary`,
`--fill-tertiary`, `--fill-quaternary`, `--text-body`, `--text-footnote`, `--text-primary`,
`--text-secondary`, `--text-tertiary`, `--text-quaternary`, `--font-code`, `--weight-semibold`,
`--space-3`, `--space-10`.

**The other three Shared Visual Language units, and where each one lands.** The settled language
has four parts. §7 folds in the grouped-inset grammar above, verbatim. The remaining three are
**content** units rather than chrome, so the shell's obligation to each is to leave it intact, not
to restyle or reimplement it:

- **QuietCard** — *not used by any primitive in this document.* It is the inline-**object** surface
  (`--fill-tertiary`, `--radius-xl`, `--shadow-subtle`), and none of the eight primitives is an
  inline object. The nearest miss is `Sheet`'s container (§5), which is a modal surface
  (`--bg-secondary` + `--shadow-overlay`) and stays one — a sheet is not a card that grew. A
  QuietCard rendered inside a `PageScaffold` scrollport is page content, and the scaffold has no
  opinion on it.
- **EmployeeChip** — *not applicable: no shell primitive renders identity.* Where a page puts one
  in a `LargeTitleHeader` trailing slot or as a `ListSection` row's leading glyph, it renders the
  settled chip unchanged — emoji avatar on a `--fill-secondary` circle at 36 / 22 / 20px, never a
  monogram, and never a shell-local variant of it.
- **StateLine** — *not applicable to chrome, and one near-miss is called out so it stays that way.*
  `PullToRefresh`'s indicator (§9) is deliberately **not** a StateLine: a StateLine reports live
  work (`--system-blue` dot, `jinn-pulse`, `Working · 12m`), and a refresh spinner is a transient
  gesture affordance with no work to report. A `ListSection` row whose content *is* live work
  renders the settled StateLine unchanged.

*Source: Apple HIG (grouped inset lists — the inset container, the section header above it, the
footer caption below). HIG's separators between rows are declined (§10.1); the settled Jinn
grouped-inset grammar wins, and it predates this document.*

---

## 8. `NavStack`

The push/pop transition contract for a route that behaves like a stack.

**It builds on `web/components/edge-back/`. It does not replace it, and it does not contain a
second gesture implementation.** That layer already ships, is already mounted, and is already
tested. Every symbol below is exported at the base SHA:

| Symbol | File | What it is |
| --- | --- | --- |
| `useEdgeBackGesture(enabled, handlers)` | `web/components/edge-back/use-edge-back-gesture.ts` | Binds pointer events and feeds the reducer |
| `reduceEdgeBack(state, event, view)` | same | The pure transition — thresholds testable without a browser |
| `useCoarsePointer()` | same | `(pointer: coarse)`; the gesture arms on touch only |
| `EDGE_GUTTER_PX` | same | `24` — the strip a drag may start in, measured from the glass, deliberately *not* from `--safe-left` |
| `AXIS_LOCK_PX` | same | `8` — the same lock the chat-row swipes use, so the two decide "this is a scroll" at the same moment |
| `COMMIT_RATIO` | same | `0.35` of viewport width |
| `COMMIT_VELOCITY` | same | `0.5` px/ms — the flick that commits regardless of distance |
| `usePreviousViewSnapshot(contentRef)` | `web/components/edge-back/previous-view-snapshot.ts` | Photographs each route one `rAF` after it paints, keyed on its own history entry, so the entry behind the cursor is already a clone when the next navigation needs it; returns `{ previous, canGoBack }` |
| `RETAINED_NODES` | same | `12_000` — the eviction budget for retained snapshots |
| `EdgeBackLayer({ contentRef })` | `web/components/edge-back/edge-back-layer.tsx` | The host, the mounted clone, the `--scrim` overlay, and the `touch-pan-y` gutter strip |

`EdgeBackLayer` is mounted once, in `web/components/page-layout.tsx`, gated on `useCoarsePointer()`
and placed before the content div in DOM order — which is what puts the previous view *underneath*
the live one during a drag.

**What `NavStack` adds, and only this.** The gesture layer answers "the reader dragged back". It
does not answer "the reader tapped a row and a detail page pushed in". `NavStack` is the routing
and transition contract for the other direction, specified so a tapped back and a dragged back are
indistinguishable at the pixel level.

**Anatomy.** No DOM of its own beyond a transition wrapper. It contributes:

1. **A push transition** — the incoming view translates from `translate3d(100%,0,0)` to `0`; the
   outgoing view translates to `-25%` and takes a `--scrim` overlay fading `0 → 1`.
2. **A pop transition** — the exact inverse, and the one a completed drag hands off to.
3. **A back affordance** — a leading chevron in `LargeTitleHeader`, 44px (§10.4), rendered when
   `usePreviousViewSnapshot` reports `canGoBack`. It is the mouse user's back, since the gesture
   arms only on a coarse pointer.

**The constants are shared, not re-derived.** `25%` is `PARALLAX = 0.25`, and the timing is the
exact string `TRANSITION` already holds — `var(--duration-base) var(--ease-smooth)`. Both live in
`web/components/edge-back/edge-back-layer.tsx:11` and `:13`, and both are **module-private `const`
at the base SHA** — unlike every symbol in the table above, which is exported today. So the slice
that builds `NavStack` exports those two from that file and imports them; it does not retype
`0.25` or the timing string. A tapped back that used a different distance or a different curve
from a dragged back is the defect this rule exists to prevent.

**States.** `idle` · `pushing` · `dragging` (owned entirely by `useEdgeBackGesture`; `NavStack`
contributes nothing while a finger is down) · `settling-commit` (animates to full width, then
`navigate(-1)` after the parsed `--duration-base`) · `settling-cancel` (animates back to `0`) ·
`popping` · `reduced motion` (no transition; the route swaps — matching `EdgeBackLayer`, which
already skips painting under `usePrefersReducedMotion` and navigates immediately).

**Breakpoint behaviour.** Below `lg`: full push/pop transitions, gesture armed on touch. At `lg`
and up: no push transition at all. Desktop routes are not a stack — the rail is the "you are here"
cue, and sliding a 1440px page sideways on a click is a phone idiom on a mouse. The back chevron
still renders when `canGoBack`; only the animation stands down.

**Tokens.** `--scrim`, `--duration-base`, `--ease-smooth`, `--bg` (the host's opaque backing, so a
translucent route never shows the page behind it mid-drag), `--text-primary`, `--fill-secondary`.

*Source: Ionic (page-transition model — incoming from the trailing edge, outgoing parallaxed and
dimmed, nav bar cross-fading independently). Apple HIG (interactive pop as the system gesture).
Ionic's iOS timing is ~540ms on a custom curve; Jinn's numbers are Jinn's (§10.5).*

---

## 9. `PullToRefresh`

An overscroll-triggered refresh at the top of a scaffold-owned scrollport. Opt-in per page.

**Anatomy.** A single indicator in the overscroll gap above the content: a 20px circular glyph,
`--text-tertiary`, on no background — no card, no elevated circle, no bezel, no text label.
The gap itself is the scrollport's own overscroll; nothing is inserted into layout at rest, so an
armed page and an unarmed page have identical resting geometry.

**Thresholds.** Arm at 64px of overscroll (`--space-16`), which is comfortably clear of
`AXIS_LOCK_PX` and cannot be reached by an accidental tap-scroll. Release below it cancels.

**States.**

| State | Indicator |
| --- | --- |
| `idle` | not rendered |
| `pulling` | `opacity` and `rotate` track pull distance, `--text-quaternary` → `--text-tertiary` |
| `armed` | full opacity, `--text-secondary`, one `scale(1.06)` tick at `--duration-fast` |
| `refreshing` | continuous rotation, `900ms` linear period (see below), `--text-secondary` |
| `settling` | fades out over `--duration-base`, scrollport returns to `0` |
| `reduced motion` | no rotation; the glyph holds at full opacity for the duration of the refresh |

**The one literal duration in this document, and why it is not a token.** The `refreshing`
rotation is authored as `900ms`, not as `--duration-*`. The token rule exists so reduced motion
can collapse an animation to `--duration-instant`; applied to a *continuous* rotation that
collapse would spin the glyph roughly a thousand times a second rather than stop it. Reduced
motion is handled one row above instead — the rotation is not applied at all and the glyph holds
at full opacity — which is the accessible behaviour outright, not an approximation of it. No
Ledger duration is within an order of magnitude of a spinner's period, and §11 deliberately does
not ask PLA-191 for one: a rotation period is a property of this indicator, not a shared motion
step that other surfaces would consume.

**Gesture ownership, stated because two gestures share this surface.** `PullToRefresh` is vertical
and lives inside the scrollport. `useEdgeBackGesture` is horizontal and starts within
`EDGE_GUTTER_PX` of the left edge, and its `lockAxis` makes a vertical lock final for the rest of
the gesture. They cannot both claim one drag, and neither needs to know about the other — but a
pull that begins inside the 24px gutter must not fight the gutter strip's `touch-pan-y`, which
concedes exactly the vertical scroll. That is why `touch-pan-y` is the correct declaration there
and why this spec does not change it.

**Breakpoint behaviour.** Below `lg` only. At `lg` and up it does not arm: a desktop reader has no
overscroll gesture on a trackpad that means "refresh", and the page's refresh lives in the header's
trailing slot as an explicit control.

**Tokens.** `--text-secondary`, `--text-tertiary`, `--text-quaternary`, `--space-16`,
`--duration-fast`, `--duration-base`, `--ease-smooth`.

*Source: Ionic (`ion-refresher` — the pull/arm/refresh/settle state machine and its thresholds).
Material 3 (pull-to-refresh indicator). Both render the indicator as an elevated surface floating
over the content; Jinn renders a bare glyph (§10.2).*

---

## 10. Conflicts — borrowed idiom versus Jinn rule

Each row: what the source does, what Jinn says, who wins, why.

### 10.1 Hairlines — **Jinn wins.**

**Borrowed.** Apple HIG and Konsta UI v5 both draw 1px separators as basic structure: under a nav
bar once content scrolls beneath it, between rows of a grouped inset list, around a segmented
control's track and its thumb.

**Jinn.** Taste §2, restated verbatim from the design skill: *"No hairlines at rest. Separation comes from
soft fills + shadow + whitespace — never a 1px border on the input, buttons, chips, or cards.
(Elevated menus may carry the shadow's built-in ~0.5px ring; that's it.)"*

**Winner: Jinn**, everywhere in this document, with no exception granted to any of the eight
primitives.

- `LargeTitleHeader` never gains a bottom border on scroll. It carries `--material-thick` plus a
  backdrop blur *at all times*, so content passing beneath it is already visibly separated and
  there is no state change to draw. This is the specific case PLA-190 was asked to call out, and
  it is the one that most tempts a borrowed implementation, because Ionic and HIG both animate a
  separator in at the collapse boundary.
- `ListSection` has no inter-row separators. The grouped-inset container plus row hover fills
  carry it — the settled Shared Visual Language, unchanged.
- `SegmentedControl` has no track border and no thumb border: `--fill-tertiary` track,
  `--bg-secondary` thumb, `--shadow-subtle`, `--inset-shine`.
- `Sheet` has no border: `--shadow-overlay` already carries the faint ~0.5px per-theme ring, which
  is the carve-out the rule itself grants, used *instead of* a border and not in addition to one.

`--separator` and `--separator-opaque` exist and remain the only acceptable hairline, *only where
genuinely needed*. No primitive in this document needs one.

### 10.2 Material elevation versus Jinn shadow tokens — **Jinn wins.**

**Borrowed.** Material 3 defines elevation as a dp scale (levels 0–5) and, in its dark scheme,
*tints* a surface by its elevation.

**Jinn.** Five shadow tokens, no scale and no tinting: `--shadow-subtle`, `--shadow-ambient`,
`--shadow-key`, `--shadow-card`, `--shadow-overlay`.

**Winner: Jinn.** Depth is chosen by *what the thing is*, not by a dp number: cards get
`--shadow-card`, floating menus and pills get `--shadow-overlay`, the FAB gets `--shadow-key`,
the segmented thumb gets `--shadow-subtle`. Surface tint-by-elevation is not adopted at all — a
surface's colour comes from `--bg-secondary` or a `--fill-*`, and both themes are authored, so a
tint computed from elevation would fight the token that already answered the question. This is
also why `PullToRefresh` renders a bare glyph rather than Material's elevated indicator circle:
there is no elevation level to give it.

### 10.3 Material FAB colour roles versus Ledger `--accent` — **Jinn wins.**

**Borrowed.** Material 3 assigns the FAB a container role — primary / secondary / tertiary
container, each with its matched on-container colour — and treats the choice as an emphasis dial.

**Jinn.** `--accent`, `--accent-fill`, `--accent-contrast`. One accent, themed, plus the
`--system-*` family reserved for status meaning.

**Winner: Jinn.** `PrimaryAction` is `--accent` with an `--accent-contrast` glyph, at every
breakpoint and in both themes. No container taxonomy, and no per-page emphasis choice: a page has
exactly one primary action, so an emphasis dial has nothing to dial between. A destructive primary
action does not recolour the FAB either — it uses `--danger-fill` on the confirming control inside
the `Sheet` it opens, which is where a destructive choice belongs.

### 10.4 iOS 44pt tap target versus Jinn's ≥34px minimum — **Jinn wins on the floor.**

**Borrowed.** Apple HIG specifies 44×44pt as the minimum comfortable tap target.

**Jinn.** *"Every change fits narrow widths and feels native — real tap targets (≥34px)."*

**Winner: Jinn.** 34px is the floor and this document does not raise it. `SegmentedControl` sits
exactly on it at 34px, and that is correct, not a violation.

HIG's 44 is adopted as the *specified size* for three controls only, and the reason is the same in
all three: they are reached by a thumb rather than aimed at with a cursor.

| Control | Size | Why 44 rather than 34 |
| --- | --- | --- |
| `PrimaryAction` | 56px | Material's FAB standard; bottom-corner thumb reach |
| `NavStack` back chevron | 44px | Top-leading corner, the hardest one-handed reach on a 390px phone |
| `ListSection` row | 44px min-height | Matches `ITEM_SIZE = 44` in `web/routes/todos/list/list-virtualizer.ts`, so a windowed estimate does not fight the real row |

That is a per-control specification, not a raised global minimum. Anything not in that table
answers to 34px.

### 10.5 Ionic page-transition motion versus Jinn motion rules — **Jinn wins.**

**Borrowed.** Ionic's iOS page transition runs ~540ms on its own cubic curve, with a parallaxed
outgoing view, a dimming overlay, and a nav bar that cross-fades independently of the content.

**Jinn.** Motion is transform/opacity, short and smooth; `--duration-slow` is `260ms` and is the
longest thing available; `--ease-spring|smooth|snappy` are the only curves.

**Winner: Jinn.** The *grammar* is borrowed wholesale — incoming from the trailing edge, outgoing
parallaxed, a scrim over the outgoing view, the nav bar's titles cross-fading on their own clock.
The *numbers* are Jinn's, and specifically they are the numbers `edge-back-layer.tsx` already
uses: `PARALLAX = 0.25` and `TRANSITION = "var(--duration-base) var(--ease-smooth)"`. §8 restates
those rather than minting new ones precisely so that a tapped back and a dragged back cannot
diverge. Ionic's 540ms would also break the reduced-motion contract for free, since it is not a
token and would not collapse at `web/routes/globals.css:847-849`.

### 10.6 Ionic's `IonContent` scroll host versus the existing scrollport contract — **Jinn wins.**

**Borrowed.** `IonContent` owns scrolling inside its own shadow DOM and exposes it through
component methods (`getScrollElement()`, `scrollToTop()`).

**Jinn.** Three existing consumers read the scrolling element as a plain DOM node:
`useScrollAnchor`, `useBoardScroll`, and TanStack Virtual via `getScrollElement`.

**Winner: Jinn.** `PageScaffold` owns the scrollport but exposes a real element (§1.3). An opaque
scroll host would break all three, and `useVirtualBlockOffset` — which measures
`block.top - node.top + node.scrollTop` — cannot be expressed against a component API at all.

### 10.7 Konsta UI's iOS/Material theme split versus one Jinn surface — **Jinn wins.**

**Borrowed.** Konsta UI v5 ships every component twice, iOS and Material, and switches on platform.

**Winner: Jinn.** One set of primitives, switched on **breakpoint**, never on platform. Jinn's web
UI runs in a Tauri shell and in a browser on the same machine; a platform switch would make the
same page look like two products. Where this document takes a form factor from iOS (the sheet
grabber, the centred inline title) and another from Material (the FAB), it takes it at *all*
breakpoints below `lg`, on every platform.

---

## 11. Token gaps handed to PLA-191

Per the scope rule, this spec consumes Ledger as it stands. Three properties a primitive here
reaches for **do not exist** at the base SHA. Two are real gaps and are named rather than used;
the third is settled here as a non-gap, so PLA-191 inherits a decision instead of a question:

1. **A tab-bar height token.** `PrimaryAction` needs `MobileTabBar`'s height to clear it and
   currently must write the literal `55px` (§4). The bar's own box is
   `min-h-[49px]` (`web/components/chat/mobile-tab-bar.tsx:85`) plus `py-1.5` (same file, `:58`).
   One token, declared next to `--safe-bottom`, removes the literal from at least three call
   sites — the FAB, the scaffold's below-`lg` bottom padding, and `todo-list.tsx`'s `pb-24`.
2. **A large-title collapse distance — settled, and not a token.** `--jinn-collapse-distance`
   stays the inline per-instance property §1.4 sets from the large title's own measured height.
   PLA-191 declares no Ledger token for it. A fixed global distance would be wrong rather than
   merely coarser: `--text-large-title` is a `clamp()` multiplied by `--text-scale`, so the
   title's rendered height moves with the reader's text-size setting, and one constant range
   would finish the collapse early at large scales and leave it unfinished at small ones. This
   entry exists to close the question, not to hand it on.
3. **A progress/spinner colour role.** `PullToRefresh` borrows `--text-secondary` for its
   indicator. That reads correctly, but a spinner is not text, and the next spinner in the app
   will make the same borrow independently.

Neither gap blocks PLA-192..195. Each is a one-line addition to both theme blocks, and per Jinn
taste every new token ships in *both*.

---

## 12. Out of scope

- All code, components, tests and CI gates. This document is a contract; PLA-191..195 implement it.
- Any dependency on Ionic or Konsta UI. Settled: steal the grammar, not the package.
- New tokens or colours beyond the two gaps named in §11.
- Rewriting the Jinn design skill. PLA-195 owns that update; §5 and §7 quote the settled
  editable-sheet contract and Shared Visual Language verbatim and change neither.
- Chat. It stays chromeless and draws its own rail and pills.
- Drag-between-detents on `Sheet` (§5), and any second gesture recogniser.
- Anything under the Tauri shell work (PLA-188/189).

**Verification.** Reading, not running. Nothing here renders, so there are no viewports or themes
to screenshot at this stage. Each primitive's own screenshot gate — 1440×900 and 390×844, light
and dark, one theme or one breakpoint being a failed gate rather than a partial one — belongs to
the slice that builds it.
