# QA verification pass: chat refine

Verification report for the five operator defects behind ICI-817, measured against the numbers
in `docs/design/chat-motion-and-typography.md`. No product code was changed by this
pass; a failing defect is handed back to the child that owns it. The one other thing this pass
adds is `scripts/device-scroll-fixture.mjs`, which exists so defect 3's blocked checklist can
hand the operator a URL that actually reaches a phone — see that section for why it has to be
printed rather than written down.

| # | Defect | Owner | Verdict |
| --- | --- | --- | --- |
| 1 | First send does not blank or reload the transcript | ICI-819 | **PASS** |
| 2 | Optimistic send, enter transition, failure + retry | ICI-820 | **PASS** |
| 3 | Mobile flick coasts with momentum and rubber-bands | ICI-821 | **BLOCKED** |
| 4 | Opening a chat lands at the bottom on first paint | ICI-821 | **FAIL** |
| 5 | Typography matches the spec's decision | ICI-822 | **PASS** |

Reduced motion was checked as a cross-cutting concern and passes; it is recorded after defect 5.

---

## How this was measured

A throwaway gateway on port **7781** (loopback, `authRequired: false`, its own home), built from
this worktree. Never port 7777, never 7788, and the foreign listener already on 7779 was neither
used nor touched. `pnpm dev` was not used. The sandbox is destroyed at the end of the run.

Three fixtures were seeded into the sandbox home only:

| Fixture | Contents |
| --- | --- |
| long transcript | 220 messages, plain prose, 1–4 paragraphs per assistant row |
| image transcript | 210 messages, a same-origin PNG attached to every fifth exchange |
| typography | one-word message, bare long URL, fenced code block, inline code, multi-line prose |

The browser is driven through `agent-browser` on an isolated profile. Geometry is sampled
**post-paint**: a `requestAnimationFrame` callback registered at document start runs before every
other rAF in its frame, so reading there reports the state a frame is *about to be* painted with,
not the state it *was* painted with. The sample is therefore taken from a task scheduled out of
that rAF, which the browser runs after the frame's rendering steps. Every `scrollTop` /
`scrollTo` / `scrollBy` write on `.chat-messages-scroll` is recorded with its landing gap and the
frame it happened in.

`d` below always means `scrollHeight − scrollTop − clientHeight`.

---

## Defect 1 — first send does not blank or reload the transcript — **PASS**

Owner **ICI-819**. A fresh chat (`[data-chat-pane-session="new"]`) was sent into, which promotes
the pane to a real session id and rewrites the URL — the transition the original defect lived in.
Across the send the probe watched three things every frame for 20 seconds: whether the live
`.chat-messages-scroll` node is still the same object captured before submit, whether a
MutationObserver on the document ever saw that subtree removed, and the rendered message count.

| | 1440×900 | 390×844 |
| --- | --- | --- |
| pane before → after | `new` → session id | `new` → session id |
| URL changed | yes | yes |
| frames sampled | 1201 | 1201 |
| transcript identity breaks | **0** | **0** |
| transcript detach events (MutationObserver) | **0** | **0** |
| frames with no transcript in the DOM | **0** | **0** |
| message count first → last | 1 → 3 | 1 → 3 |
| count decreases | **none** | **none** |

The container is never unmounted and the rendered count never drops.

`routes/chat/__tests__/first-send-continuity.test.tsx` and
`components/chat/__tests__/first-send-continuity.test.tsx` are green (see the suite run at the
end).

---

## Defect 2 — optimistic send, enter transition, failure + retry — **PASS**

Owner **ICI-820**.

### The bubble is in the DOM in the same frame as submit

`document.timeline.currentTime` does not advance inside a frame, so it identifies the frame. It
was read immediately before the submit click, and again from a MutationObserver microtask fired
by the insertion itself:

```
submitFrame  169926.9
bubbleFrame  169926.9   → same frame
```

### Enter animation

Computed style on the inserted bubble, read from that same microtask:

```
animation-name        jinn-msg-send-in
animation-duration    0.18s              (= --duration-base, 180ms)
animation-timing      cubic-bezier(0.4, 0, 0.2, 1)   (= --ease-smooth)
animation-fill-mode   backwards
transform-origin      258.516px 48.9844px
```

`transform-origin` resolves to pixels, so it was checked against the element's own box. The
border box measured `248.175 × 47.025` **while the `scale(0.96)` keyframe was applied**;
`248.175 / 0.96 = 258.516` and `47.025 / 0.96 = 48.9844`, i.e. the origin is exactly the
bottom-right corner — `100% 100%`.

### The three states

`--shadow-subtle` in the dark palette is `0 1px 2px rgba(0,0,0,0.30)`; `--danger-fill` is
`rgba(224,103,90,0.14)`. Measured values, with the enter animation cancelled so `getComputedStyle`
reports the state's own declarations rather than the animation interpolating over them:

| State | `data-send-state` | opacity | box-shadow | background |
| --- | --- | --- | --- | --- |
| pending | `pending` | **0.72** | **none** | `rgba(224,163,60,0.14)` (`--accent-fill`) |
| settled | absent | **1** | `rgba(0,0,0,0.3) 0px 1px 2px 0px` (**`--shadow-subtle`**) | `rgba(224,163,60,0.14)` |
| failed | `failed` | 1 | none | `rgba(224,103,90,0.14)` (**`--danger-fill`**) |

The settled row was also observed without any intervention: the enter animation interpolates
opacity `0 → 1` over 180ms and the box-shadow settles to `rgba(0,0,0,0.3) 0px 1px 2px 0px` at
t = 204ms, with `animation-play-state: none` from there on.

Note for future probes: the resting state is the **absence** of `data-send-state`, not the string
`sent`.

### Failure and retry

The send route was aborted at the network layer to force a real transport failure. Measured on
the failed bubble:

```
background-color   rgba(224, 103, 90, 0.14)     --danger-fill
box-shadow         none
bubble text        preserved  ("QA probe: forced send failure")
failure row        "Not delivered·Retry",  title="Failed to fetch"
retry button       .send-failure-row .send-retry-btn, text "Retry", enabled
user bubbles       1
```

Nothing vanished. The route was then removed and Retry clicked: the message resent, the session
was created, the failure row disappeared, and the bubble settled to `opacity: 1`, `--accent-fill`,
`--shadow-subtle` — with **1** user bubble, not two.

### Reconcile does not duplicate and does not re-animate

One send in an existing session, watched for 20 seconds (1202 frames) across the server reconcile:

```
bubble node swaps                    0
distinct jinn-msg-send-in startTimes 1   (329953.9; the earlier "null" is the same animation before it started)
animation currentTime regressions    0
distinct data-message-id values      1   (8ce58c6a-…) — the optimistic id survives the reconcile
bubbles carrying the sent text       min 1 / max 1
rendered rows                        3 → 5, never decreasing
```

`message-send-state.test.ts`, `message-enter-motion.test.tsx` and `send-motion-tokens.test.ts`
are green.

---

## Defect 3 — mobile flick momentum and rubber-band — **BLOCKED**

Owner **ICI-821**. Not verified, and **not substituted with touch emulation**.

### Why it is blocked

There is no physical iOS device reachable from this host. The only paired iPhone reports offline:

```
$ xcrun xctrace list devices
== Devices ==
<this Mac>

== Devices Offline ==
iPhone (26.5) (…)

$ xcrun devicectl list devices
Name     Hostname                  Identifier   State           Model
iPhone   iPhone.coredevice.local   …            unavailable     iPhone17,2
```

Even with the device online, the property under test is momentum after a *release* — the coast a
finger imparts and the rubber-band at the ends. A desktop browser's touch emulation dispatches
synthetic touch events; it does not run the platform's fling physics, and `-webkit-overflow-
scrolling: touch` plus the elastic overscroll behaviour are exactly the parts that only exist on
the device. Reporting a desktop emulation result as a pass here would be reporting the wrong
thing, so this is recorded as BLOCKED per the Todo's own instruction.

### Operator checklist — about 60 seconds

The sandbox this pass used was destroyed, per the run's own cleanup rule, and a URL that reaches
a phone names this machine — which is the one thing a public repository must not carry. So the
URL is not written here; it is *printed*, by the second command below, from the addresses the
machine actually holds when you run it. Nothing here is a blank to fill in.

Every one of the three is prefixed with `pnpm exec`, and that is not decoration. `.npmrc` pins
`use-node-version=24.13.0`, so `pnpm exec` puts that Node first on `PATH` for whatever it runs —
including the sandbox helper, which shells out to a bare `node`. Drop the prefix on a machine
whose `PATH` leads with a different Node and step 1 dies inside `--seed` on better-sqlite3's ABI
check (`NODE_MODULE_VERSION 137 ... requires NODE_MODULE_VERSION 147`) before the sandbox exists.

Run all three from a checkout of this branch:

```bash
# 1. create a throwaway sandbox on a free port ≥7778 (never 7777, never 7788), do not start it.
#    --seed is what materialises the registry tables step 2 writes into.
JINN_REPO="$(git rev-parse --show-toplevel)" \
  pnpm exec ~/.jinn/skills/jinn-sandbox/scripts/jinn-sandbox.sh create qa-flick --port 7782 --build --seed

# 2. seed a transcript long enough to flick, open the bind so the phone can route to it, and
#    print the URL.
pnpm exec node scripts/device-scroll-fixture.mjs --home ~/.jinn-qa-flick

# 3. start it
pnpm exec ~/.jinn/skills/jinn-sandbox/scripts/jinn-sandbox.sh start qa-flick
```

Step 2 prints the URL and the pairing command, e.g.:

```
Seeded 220 messages into session "device-scroll-check".
Bind opened to 0.0.0.0 — start the sandbox, then open this on the phone:

  http://198.51.100.24:7782/?session=device-scroll-check

A non-loopback bind always requires auth. Pair the phone with the code from:
  jinn -i jinn-qa-flick pair
```

(That address is RFC 5737 documentation space standing in for whatever the command prints on the
day; the real one comes from the machine's own interfaces, tailnet — 100.64/10 — first.)

Two things worth knowing before you run it. A non-loopback bind turns authentication on by
itself — `shouldRequireGatewayAuth` returns true for `0.0.0.0` — so the phone will ask to pair,
and that is the sandbox refusing to sit unauthenticated on the network rather than something
going wrong. And run the `pair` command with `JINN_PORT` and `JINN_HOME` unset: both leak from a
gateway session's environment and beat `-i`, which would point the CLI at the live instance.

All three commands above were run in sequence from this checkout, deliberately with a foreign
Node 26 leading `PATH` so the `pnpm exec` prefix was the only thing standing between the run and
the ABI check: the sandbox came up on 7782, 220 rows landed in `messages`, `gateway.host` was
rewritten to `0.0.0.0`, the command printed the tailnet URL ahead of the LAN one, the started
gateway answered `200` on the seeded session, and the sandbox was destroyed afterwards.

`scripts/__tests__/device-scroll-fixture.test.mjs` covers what the script refuses and what it
must not do halfway. It will not rewrite a home named `.jinn` or one configured on 7777 or 7788;
it ranks only Tailscale's 100.64/10 ahead of the LAN and the LAN ahead of everything else, with
both enumeration orders asserted because a rank the LAN shares with public space is settled by
`os.networkInterfaces()` rather than by the sort, so a public 100/8 address is never offered as
the phone URL; and when the sqlite addon cannot load — the ABI mismatch a bare `node` walks into
— it aborts with a message naming the pinned Node and `pnpm exec node`, leaving
`config.yaml` byte-identical rather than a sandbox bound to `0.0.0.0` with an empty thread. Each
of those goes red when its fix is reverted, verified one at a time.

Four steps:

1. **Flick the transcript.** Swipe up hard and lift your finger.
2. **Confirm it coasts.** The transcript should keep sliding after the finger leaves and decay
   smoothly to a stop — not halt the instant you release.
3. **Overscroll at both ends.** Drag past the top of the thread, then past the bottom.
4. **Confirm rubber-band.** Each end should stretch and spring back rather than stopping dead,
   and the page behind the transcript must not scroll with it.

Then destroy it, pass or fail:

```bash
~/.jinn/skills/jinn-sandbox/scripts/jinn-sandbox.sh destroy qa-flick --yes
```

---

## Defect 4 — chat opens at the bottom on first paint — **FAIL**

Owner **ICI-821**. The plain-transcript half of the criterion passes cleanly. The
**image-transcript half fails**: the first painted frame is at the bottom, but the transcript then
paints one to two further frames up to **600px** above the bottom before a post-paint write pulls
it back — which is the "opens, then jumps" symptom the defect is about, and which the criterion
forbids by requiring no intermediate `scrollTop` write after first paint.

### Long transcript (220 messages, no images) — clean

Per-open log, `d` on the first painted frame:

| Viewport | Opens | first-paint `d` | painted frames with `d > 0` | writes after first paint |
| --- | --- | --- | --- | --- |
| 1440×900 | 10 / 10 | **0** every open | 0 | 0 |
| 390×844 | 15 / 15 | **0** every open | 0 | 0 |

Representative line (identical across every open of that batch):

```
open  7: firstPaint d=0 scrollTop=27583 scrollHeight=28303 clientHeight=720 rows=19
         paintedFrames=136 maxGapAfter=0 gapFrames=0 writesPre=39 writesPost=0
         writesPostOffBottom=0 unmounts=0
```

### Image transcript (210 messages, PNG every fifth exchange) — fails

| Viewport | Opens | first-paint `d` | painted frames with `d > 0` | max `d` after first paint | writes after first paint | of those, landing off the bottom |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 10 / 10 | **0** every open | **1–2** every open | **600px** | **6** | **2** |
| 390×844 | 10 / 10 | **0** every open | **1** every open | **415px** | 3 | 0 |

The failing frame sequence at 1440×900, from one open (every open of the batch reproduces it):

```
epoch 22  t=359.1  d=0     scrollTop=19836  scrollHeight=20596  rows=14   ← first paint, correct
epoch 23  t=368.1  d=600   scrollTop=19836  scrollHeight=21196  rows=17   ← painted 600px short
epoch 24  t=383.0  d=101   scrollTop=20335  scrollHeight=21196  rows=17   ← painted 101px short
epoch 25  t=397.3  d=0     scrollTop=20335  scrollHeight=21095  rows=15   ← recovered
```

and the writes that happened after first paint, with the gap each one left:

```
t=362.6  scrollTo   top=19836  gapAfter=0     (virtualizer scrollToFn)
t=362.7  scrollTo   top=19836  gapAfter=0     (virtualizer scrollToFn)
t=382.3  scrollTop= top=20436  gapAfter=0
t=382.4  scrollTo   top=20410  gapAfter=26    ← lands off the bottom
t=382.4  scrollTo   top=20335  gapAfter=101   ← lands off the bottom
t=396.7  scrollTop= top=20335  gapAfter=0
```

**Mechanism.** The first paint is correct. Three more rows then mount and their images decode, so
`scrollHeight` grows `20596 → 21196` while `scrollTop` stays at `19836`; the two `scrollToFn`
writes in that same frame were computed against the pre-growth height, so they land at
`gapAfter=0` and do nothing to prevent the gap. The reader sees roughly two frames — about 38ms —
of the transcript sitting 600px then 101px above the bottom, then a snap. It is deterministic:
20 of 20 opens across both viewports.

### A confound worth recording, because it changes what "intermittent" means here

Before the sandbox's first-run onboarding wizard was dismissed, the **plain** long transcript
failed at 390×844 on **3 of 30 opens** — first paint at `d=2058`, `rows=10`, `writesPre=7`, then
34 corrective writes of which 24 landed off the bottom. Once `portal.onboarded` was set and the
wizard stopped mounting, the same fixture was clean 15 of 15. The wizard is lazily imported
(`page-layout.tsx` → `lazy(() => import("./onboarding-wizard"))`), so its chunk lands an extra
commit inside the open window. That is the same failure mode as the image case — content
arriving after the opening write — reached by a different route, and it says the open path is
sensitive to *any* late commit, not only to images.

### The rest of defect 4's criterion — all clean

**Scrolling up and staying up is not overridden by new content.** With the reader parked 1500px
above the bottom while an assistant reply streamed in (content grew 298px over 20 seconds,
1129 frames sampled):

```
anchor scrollTop  19905      final scrollTop 20020   (a 115px anchoring adjustment)
gap d             1500  →  1683                       (the reader moved further from the bottom)
ever pinned (d ≤ 56)  false
```

The visible gap never shrank, so the reader was never yanked down; the 115px `scrollTop` movement
is native scroll anchoring compensating for rows measured above the viewport, which preserves the
visual position rather than changing it.

**The down-arrow's 56px rule** (`STICK_THRESHOLD_PX = 56`), measured at both viewports by moving
the scroller to an exact gap and reading `button[aria-label^="Jump to latest"]` after the state
commits:

| Step | `d` | 1440×900 | 390×844 |
| --- | --- | --- | --- |
| at rest | 0 | absent | absent |
| scrolled up | 200 | visible | visible |
| one over threshold | **57** | **visible** | **visible** |
| at threshold | **56** | **absent** | **absent** |
| back at bottom | 0 | absent | absent |

**`e2e/scroll.spec.ts`** run against the sandbox port, not `playwright.config.ts`'s hardcoded
7779 (which has a foreign listener this run did not start and did not touch):

```
$ SCROLL_E2E_URL=http://127.0.0.1:7781 SCROLL_E2E_SESSION=<long transcript> \
    npx playwright test e2e/scroll.spec.ts --reporter=list

  ✓  1 e2e/scroll.spec.ts:51:7 › chat stick-to-bottom › mount-snap: loads pinned to the bottom (2.3s)
  ✓  2 e2e/scroll.spec.ts:56:7 › chat stick-to-bottom › read-up: scrolling up reveals "Jump to latest", click returns to bottom (3.2s)
  ✓  3 e2e/scroll.spec.ts:72:7 › chat stick-to-bottom › resize: a viewport shrink while pinned stays pinned (no composer overlap) (2.8s)

  3 passed (8.9s)
```

`transcript-open.test.tsx`, `use-stick-to-bottom.open.test.tsx`, `chat-scroll-anchor.test.tsx`
and `chat-messages-jump.test.tsx` are green. The unit suites cover the opening write; none of
them covers a row that grows *after* first paint, which is the case that fails here.

---

## Defect 5 — bubble type scale — **PASS**

Owner **ICI-822**. Computed styles on the live bubbles, measured at the two widths the spec's
§5 arithmetic is stated for:

| | spec | 390px measured | 1024px measured |
| --- | --- | --- | --- |
| user `font-size` | 16px / 17px | **16px** | **17px** |
| user `font-weight` | `--weight-medium` = 500 | **500** | **500** |
| user `line-height` | 16 × 1.47 = 23.52 / 17 × 1.47 = 24.99 | **23.52px** (ratio 1.47) | **24.99px** (ratio 1.47) |
| assistant `font-size` | unchanged, 16px / 17px | **16px** | **17px** |
| assistant `line-height` | same 1.47 | **23.52px** (ratio 1.47) | **24.99px** (ratio 1.47) |
| user `max-width` | 90%, 82% at ≥1024px | **90%** | **82%** |
| `--chat-measure` | `64rem` | **64rem** | **64rem** |

The ratio is 1.47 on both bubbles at both widths, so no `--leading-relaxed` (1.65) override
survives on either. The token itself still resolves to `1.65` for the elements that legitimately
use it — the notification bubble keeps `--text-caption1` + `--leading-relaxed`, which §5 did not
change and which is therefore not reported as a miss.

### Containment

At neither width does the document or the scroll container overflow horizontally
(`documentOverflowsX: false`, `scrollerOverflowsX: false`). Both bubble classes compute
`overflow-wrap: break-word` and `word-break: break-word`, and the bare long URL wraps inside the
bubble at both widths. The only element whose `scrollWidth` exceeds its `clientWidth` is the
fenced code block at 390px (`366 → 478`), which carries its own `overflow-x: auto` and scrolls
inside itself by design — the page does not move.

### Screenshots

1440×900 and 390×844, in both light and dark, on a transcript carrying a one-word message, a bare
long URL, a fenced code block, and an inline-code run, plus the long transcript at rest:

```
tmp/chat-refine-qa/typography-1440x900-light.png
tmp/chat-refine-qa/typography-1440x900-dark.png
tmp/chat-refine-qa/typography-390x844-light.png
tmp/chat-refine-qa/typography-390x844-dark.png
tmp/chat-refine-qa/transcript-1440x900-light.png
tmp/chat-refine-qa/transcript-1440x900-dark.png
tmp/chat-refine-qa/transcript-390x844-light.png
tmp/chat-refine-qa/transcript-390x844-dark.png
```

Paths are relative to the instance home; the same eight images are attached to the QA Todo.
They are not committed here — this repository is public and does not carry QA raster output.

`chat-bubble-type-scale.test.tsx` is green.

---

## Reduced motion

With `prefers-reduced-motion: reduce` emulated, and the same page read again with the emulation
off as a control:

| | reduce | control |
| --- | --- | --- |
| `.user-msg-bubble[data-msg-enter]` `animation-name` | **none** | `jinn-msg-send-in` (0.18s) |
| `.assistant-transcript[data-msg-enter]` `animation-name` | **none** | `jinn-msg-receive-in` (0.26s) |
| `[data-chat-pane-session]` `animation-name` | **none** | `jinn-chat-open` (0.18s) |

Nothing else regressed under reduce:

- `--duration-fast` and `--duration-base` both collapse to `1ms`.
- The optimistic insert still happens: after a send, the bubble is present with
  `data-msg-enter="true"`, `data-send-state="pending"`, `opacity: 0.72`, and **zero** running
  animations — the pending state renders immediately at its resting value instead of fading in.
- The open path scrolls with `behavior: 'auto'` (the opening `scrollTo` was recorded with
  `behavior: "auto"`), and the scroller computes `scroll-behavior: auto`.
- The transcript still opened at `d = 0` on the first painted frame.

---

## Gates

Run after the final edit, on the report commit.

### The ten suites this Todo names

```
$ pnpm exec vitest run \
    src/routes/chat/__tests__/first-send-continuity.test.tsx \
    src/components/chat/__tests__/first-send-continuity.test.tsx \
    src/components/chat/__tests__/message-send-state.test.ts \
    src/components/chat/__tests__/message-enter-motion.test.tsx \
    src/components/chat/__tests__/send-motion-tokens.test.ts \
    src/components/chat/__tests__/transcript-open.test.tsx \
    src/components/chat/__tests__/use-stick-to-bottom.open.test.tsx \
    src/components/chat/__tests__/chat-scroll-anchor.test.tsx \
    src/components/chat/__tests__/chat-messages-jump.test.tsx \
    src/components/chat/__tests__/chat-bubble-type-scale.test.tsx

 Test Files  10 passed (10)
      Tests  65 passed (65)
```

### Repository gates

```
$ pnpm typecheck
 Tasks:    6 successful, 6 total
> tsc --noEmit -p tsconfig.e2e.json && tsc --noEmit -p tsconfig.scripts.json

$ pnpm lint
 Tasks:    5 successful, 5 total
> eslint e2e scripts tools

$ pnpm test
@jinn/shell-desktop:test   Test Files  1 passed (1)
@jinn/gateway-events:test  Test Files  2 passed (2)
jinn-cli:test              Test Files  451 passed (451)
@jinn/web:test             Test Files  253 passed (253)
root (node:test)           tests 183   pass 183   fail 0
 Tasks:    6 successful, 6 total

$ pnpm build
 Tasks:    5 successful, 5 total
synced packages/web/out -> packages/jinn/dist/web (pruned 150 stale files)

$ pnpm ratchet --check
size ratchet: 1586 files scanned, 379 baselined files, 119534 budgeted lines (limit 300)

$ pnpm footguns
footguns: 0 violations in 131 files, 0 suppressions (0 unaudited)
```

The root `node:test` total moved 175 → 183: `scripts/device-scroll-fixture.mjs` and its eight
guard tests, added for defect 3's checklist. The two scan counts read the same with this branch's
changes stashed, so neither moved for anything in this report.

---

## Hand-back

Defect 4 is the only FAIL. It is handed to **ICI-821** with the criterion it missed and the
measurement that missed it; it is not fixed here. Defect 3 stays BLOCKED until the operator runs
the checklist above on a real device, or explicitly accepts the block.

## Adjacent problems found, reported not fixed

1. **`e2e/scroll.spec.ts` cannot select a session.** It navigates to `${BASE}/chat?session=<id>`,
   but `/chat` is `<Navigate to="/" replace />` in the router, and `Navigate` carries no search
   string — so `SCROLL_E2E_SESSION` is dropped and the app falls back to whichever session
   auto-selects. The runs above passed because the fixture happened to be the most recent session.
   The spec should use `/?session=<id>`.
2. **`playwright.config.ts` hardcodes `baseURL: 'http://localhost:7779'` and declares no
   `webServer`.** A bare `pnpm test:e2e` therefore aims at whatever happens to own 7779 on the
   machine.
3. **ICI-823 never declared `verifyPolicy.deliverable`**, so its route defaulted to `repo`. The
   report is committed here rather than inferring a workspace route around the gap.
