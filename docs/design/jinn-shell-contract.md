# Jinn Shell contract

Page chrome is a contract, not a convention. Every headed route under
`packages/web/src/routes` renders through the primitives in
`packages/web/src/components/shell/`. Chat stays chromeless.

The design spec that settled the four open questions (keep `PageLayout`,
icon-only 56px FAB, scaffold-owned scrollport, CSS `animation-timeline`
collapse) is `docs/design/jinn-shell-primitives.md`. This file is
the shipped surface: the three primitives, the gate, and the escape hatch.

Composition:

```
PageLayout                     app chrome — rail, tab bar, status bar, edge-back
└── PageScaffold               page chrome — header, scrollport, primary action
    └── <page content>
```

## Primitives

### `PageScaffold`

The page shell. A column (`flex h-full min-h-0 flex-col`) with exactly one
scrollport (`data-scrollable`) unless `scroll="external"`. The header sits
inside the scrollport so the collapse timeline can reach it. `PrimaryAction`
is a sibling of the scrollport so it does not scroll away.

The scroll node is published through `useState`, never a bare ref, so a
descendant's first layout effect sees the real element or `null` and
re-runs. The scaffold never calls `scrollTo`, never writes `scrollTop`, and
never restores on route change.

`scroll="external"` is for a route that owns its scrollports — the Todos
board mounts two of them permanently. The scaffold then creates no scroll
box, and **the header does not collapse**. That is the rule for externally
scrolled routes, not a degradation: the collapse timeline reads the nearest
block scroller, and a bar sitting above two sibling scrollports would have to
pick one and be wrong about the other. So `/todos` keeps its large title at
every scroll position, by contract, and `page-scaffold.test.tsx` and
`large-title-header.test.tsx` hold it there.

Below `lg`, bottom padding and the FAB offset both derive from
`--tab-bar-height`. At `lg` and up, padding is `lg:pb-10` and the FAB does
not render.

`contentWidth` is the route's measure (`"640px"`). The scrollport centres on
it through its own `--jinn-gutter`, so the header and the body it heads share
one left edge; a route that wraps its children in `mx-auto max-w-*` instead
puts the two on different spines. Unset, the column is the full width.

### `LargeTitleHeader`

Two layers: a sticky constant-height bar (`--material-thick` + backdrop
blur, applied at all times, no hairline in any state) and a large title as
a separate block in the scroll flow beneath it. `title` is a `ReactNode` so
a control (the Todos board switcher) can occupy the slot. Optional
`subtitle` (large state only), `trailing`, and `leading`.

The `<header>` is `display: contents`, so the bar's containing block is the
scrollport and not the header's own box — a sticky box cannot leave the block
it lives in, and the header's box ends just under the subtitle.

Collapse is CSS-only, and only where `PageScaffold` owns the scrollport:
`animation-timeline: scroll(nearest block)` on
`.jinn-large-title` / `.jinn-inline-title`. No scroll listener, no
`IntersectionObserver`, no collapsed `useState`. Unsupported engines and
`prefers-reduced-motion: reduce` take the permanently-inline fallback.
Carries no `--safe-top` — `PageLayout` already pays that inset.

### `PrimaryAction`

One call site, two form factors. Below `lg`: a 56px `--accent` circle,
icon-only, `aria-label` mandatory, sitting at
`bottom: calc(var(--tab-bar-height) + max(var(--safe-bottom), 6px) + var(--space-4))`.
At `lg` and up the FAB does not render; the same action is the header's
trailing labelled `--fill-secondary` button. `data-slot="primary-action"`
on both.

## Gate

`packages/web/src/components/shell/__tests__/shell-contract.test.ts` scans
`packages/web/src/routes` and fails CI on:

1. **No large title outside the primitive.** `--text-large-title` in a
   route source.
2. **No hand-rolled page-level accent button.** `bg-[var(--accent)]`
   together with `text-[var(--accent-contrast)]` anywhere inside one
   `className` attribute — the whole attribute span, however many lines
   prettier broke the class list over, because where the wrap falls is a
   width decision and not a design one. A pair written outside any
   `className` falls back to its own line.
3. **No new bottom sheet outside the enumerated set.** `Sheet` has not
   shipped yet. The rule enumerates the existing bottom-sheet
   implementations and fails if a new file matches the signature.

Each rule has a fixture that goes red on a deliberate violation and green
on the migrated tree.

## Escape hatch

`// jinn-shell: ok <reason>` on the offending line, matching
`// footgun: ok <reason>`. The reason is required — a hatch with no reason
does not suppress. Use it for dialog submits, editor FABs, and error
retries this contract is not chartered to rewrite. Never a blanket
suppression.
