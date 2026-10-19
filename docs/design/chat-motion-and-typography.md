# Chat motion and typography

Design spec. No product code. Base SHA `4f11638c`.

This document governs the remaining slices of the chat-refine effort. Five sections, one per defect the
operator named. A slice implements from here without asking a follow-up question: every timing,
easing, distance and size below is a number with a unit or a token quoted with its resolved
value. Where a value is already shipped, the section says so and cites the line rather than
minting a second number for the same thing.

Paths are repo-relative. `web/` abbreviates `packages/web/src/`.

---

**The motion vocabulary. Consume it; do not extend it.**

| Token | Resolved | Where |
| --- | --- | --- |
| `--duration-instant` | `1ms` | `web/routes/globals.css:260` |
| `--duration-fast` | `120ms` | `web/routes/globals.css:261` |
| `--duration-base` | `180ms` | `web/routes/globals.css:262` |
| `--duration-slow` | `260ms` | `web/routes/globals.css:263` |
| `--ease-spring` | `cubic-bezier(0.34,1.56,0.64,1)` | `web/routes/globals.css:382` |
| `--ease-smooth` | `cubic-bezier(0.4,0,0.2,1)` | `web/routes/globals.css:383` |
| `--ease-snappy` | `cubic-bezier(0.2,0,0,1)` | `web/routes/globals.css:384` |

Every animation this document introduces is authored with `var(--duration-*)`, never a literal
millisecond count. That is not a style preference: the reduced-motion block at
`web/routes/globals.css:790-796` redefines those three tokens to `--duration-instant`, so a
scale-driven animation collapses for free and a hardcoded one does not.

**The reduced-motion contract.** Two mechanisms already exist and both apply:

1. `web/routes/globals.css:790-796` collapses `--duration-fast|base|slow` to `1ms`.
2. `web/routes/globals.css:1164-1172` forces `animation-duration`, `transition-duration` to
   `0.01ms` and `scroll-behavior: auto` on every element.

A collapsed animation still *runs*, which is deliberate — `web/routes/globals.css:786-789`
records why (`animation: none` on a view transition never ends, and its snapshot freezes over
the live page). So the rule for anything new here is: author with the duration tokens, and add
an explicit `animation: none` rule in a `prefers-reduced-motion` block only where the animation
has a `both` fill whose end state is not the resting state. Each section below states its own
reduced-motion behaviour; none of them is left to the global reset alone.

**The size ratchet is at zero headroom on every file these slices touch.** `size-baseline.json`
records a budget that may only shrink (`scripts/ratchet.mjs:11-15`), gated by a required CI job.
The budget equals the current line count on all of them:

| File | lines | budget | headroom |
| --- | --- | --- | --- |
| `web/components/chat/chat-messages.tsx` | 1561 | 1561 | 0 |
| `web/components/chat/chat-input.tsx` | 1104 | 1104 | 0 |
| `web/components/chat/chat-pane.tsx` | 722 | 722 | 0 |
| `web/components/chat/chat-sidebar.tsx` | 1911 | 1911 | 0 |
| `web/hooks/use-live-session.ts` | 1430 | 1430 | 0 |
| `web/routes/chat/page.tsx` | 1210 | 1210 | 0 |

So no slice governed by this spec may add a net line to any of them. New logic lands in a new
module of ≤300 lines (`scripts/ratchet.mjs:24`) and is imported back. Each section names its
module. Trading lines out of a capped file to pay for lines in is acceptable and shrinks the
budget on the next `pnpm ratchet`; growing one is a CI failure, and raising a baseline is not an
available move.

**Out of scope for every section here.** Any change under `packages/**` in this diff — this
branch is documentation only. Implementing any defect (that is the four slices below).
Re-opening the earlier native-scroll verdict. The Talk surface, the Todo board, and every non-chat
screen. New chat features: this is feel, not function.

---

## 1. Send motion

Operator defect 2 — *"when I send a message ... there's no transition or anything like that ...
it abruptly shows up."* Owner: **the send-motion slice**. Prerequisite: **the first-send slice**, because §3's remount
destroys any enter animation before it can be seen.

### 1.1 What is already true

The optimistic append exists. `handleSend` (`web/components/chat/chat-pane.tsx:391-401`) builds
the `Message` and calls `beginSend` (`web/hooks/use-live-session.ts:1315-1328`), which appends it
synchronously. The bubble is on screen in the submit frame today. What is missing is the
transition, the state vocabulary, and an honest failure.

The bubble is `.user-msg-bubble` (`web/components/chat/chat-messages.tsx:1018`). It carries no
animation of any kind. The only enter choreography in the transcript belongs to comms rows
(`.comm-arrive`, `web/routes/globals.css:805-808`) and dispatch rows (`.dispatch-arrive`,
`web/routes/globals.css:873-885`).

### 1.2 Enter animation

```css
.user-msg-bubble[data-msg-enter] {
  animation: jinn-msg-send-in var(--duration-base) var(--ease-smooth) backwards;
  transform-origin: 100% 100%;
}
@keyframes jinn-msg-send-in {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to   { opacity: 1; transform: none; }
}
```

- **Duration** `var(--duration-base)` = `180ms`.
- **Easing** `var(--ease-smooth)` = `cubic-bezier(0.4,0,0.2,1)`.
- **Transform origin** `100% 100%` — the bottom-right corner, which is where the bubble sits in
  its right-aligned row (`web/components/chat/chat-messages.tsx:1016`) and the corner nearest the
  composer the text came from. The scale therefore reads as growing out of the send control, not
  as inflating in place.
- **Distance** `6px` of rise, `0.96` of scale. Both chosen against the shipped neighbours:
  `jinn-comm-rise` uses `4px` (`web/routes/globals.css:820`), `jinn-pop-in` uses `0.96`
  (`web/routes/globals.css:759`). The user's own message is the one row that should read slightly
  more emphatic than a comms row, hence 6px rather than 4px; the scale matches the system exactly.
- **Fill** `backwards`, so the bubble is invisible in the frame before the animation starts
  rather than flashing at full opacity.
- **Applies once, on live arrival only.** `data-msg-enter` is set only for a message whose id was
  absent at mount, using the same live-arrival bookkeeping as comms (`arrivalsRef`,
  `web/components/chat/chat-messages.tsx:1290-1309`). A message present when the transcript
  mounted never animates; that is what stops a session switch from replaying the whole history.
- **Survives reconciliation.** `reconcileMessages` (`web/lib/conversations.ts:95`) deliberately
  keeps the optimistic id and timestamp when the server twin lands
  (`web/lib/conversations.ts:81-86`) so the React key does not change. The enter animation must
  not re-run on that swap. This is already guaranteed by the id-preserving reconcile; the send-motion slice
  asserts it rather than adding a guard.

**Reduced motion.** `animation: none`. The end state of `jinn-msg-send-in` is the resting state,
so suppressing it leaves the bubble exactly where it belongs on the submit frame. The optimistic
insert itself is not motion and still happens — the bubble is on screen in the same frame in both
modes.

### 1.3 The three states, as token deltas

Resting (`sent`) is what ships today. `pending` and `failed` are deltas from it.

| Property | `pending` | `sent` (resting) | `failed` |
| --- | --- | --- | --- |
| background | `var(--accent-fill)` | `var(--accent-fill)` | `var(--danger-fill)` **(new token)** |
| color | `var(--text-primary)` | `var(--text-primary)` | `var(--text-primary)` |
| opacity | `0.72` | `1` | `1` |
| box-shadow | `none` | `var(--shadow-subtle)` | `none` |
| everything else | unchanged | — | unchanged |

Radius, padding, weight, max-width and font size are identical in all three. Nothing about a
send state may change the bubble's geometry: a size change would reflow the row and move the
transcript under the reader.

- **`pending`** is the state the bubble enters in. `opacity: 0.72` and no shadow is the whole
  signal — it reads as "not yet settled" without a spinner, a clock glyph, or a "Sending…" label.
  Quiet beats loud.
- **`sent`** adds nothing. The absence of the pending delta *is* the sent signal. A checkmark
  would be a second cue for the state that is already the default, and every message in the
  transcript would carry it forever.
- **`failed`** returns to full opacity and swaps the fill. It does not dim: a failure the reader
  can miss is worse than no state at all.

**The new token.** `--danger-fill` is derived from that block's own `--system-red` at the same
alpha that block uses to relate `--accent-fill` to `--accent`. The palette lives in **four**
blocks, not two, and the token goes in all four — a token defined in only the `[data-theme]` pair
is missing for a reader who never set a theme and is on the OS preference:

| Block | `--danger-fill` | derived from |
| --- | --- | --- |
| `:root, [data-theme="dark"]` (`web/routes/globals.css:310`) | `rgba(224,103,90,0.14)` | `--system-red: #E0675A` (`:342`), alpha from `--accent-fill` (`:336`) |
| `[data-theme="light"]` (`web/routes/globals.css:388`) | `rgba(178,59,51,0.14)` | `--system-red: #B23B33` (`:418`), alpha from `--accent-fill` (`:412`) |
| `@media (prefers-color-scheme: light)` (`web/routes/globals.css:460`) | `rgba(178,59,51,0.12)` | same red; **alpha `0.12`**, because that block's `--accent-fill` is `rgba(176,122,26,0.12)` (`:485`) |
| `@media (prefers-color-scheme: dark)` (`web/routes/globals.css:522`) | `rgba(224,103,90,0.14)` | same as the dark `[data-theme]` block |

The light-media block's `0.12` is not a typo to normalise: that block already carries a slightly
lighter accent fill, and the danger fill tracks its neighbour rather than the other blocks.

**State transitions.** `pending → sent` and `pending → failed` animate
`transition: opacity var(--duration-fast) var(--ease-smooth), background-color var(--duration-base) var(--ease-smooth), box-shadow var(--duration-base) var(--ease-smooth)`
— `120ms` for the opacity lift, `180ms` for the colour. No transform, so the row never moves.
**Reduced motion:** both durations collapse to `1ms` through the token block at
`web/routes/globals.css:790-796`; the state change is still applied, instantly. No extra rule is
needed and none should be added.

### 1.4 The failed state's recovery affordance

A row below the bubble, right-aligned with it:

- Text: `Not delivered` in `var(--text-tertiary)`, then a separator dot, then **`Retry`** as a
  button in `var(--system-red)`.
- Size `var(--text-caption1)` = `clamp(0.6875rem, 0.6491rem + 0.1577vw, 0.75rem)` — `11px` at
  390px, `12px` at 1024px.
- Hit area `≥34px` in both dimensions on coarse pointers, per the mobile tap-target rule. The
  label is smaller than that, so the button carries the padding to reach it.
- Enters with the bubble's `failed` transition: `opacity 0 → 1` over `var(--duration-base)`
  (`180ms`) `var(--ease-smooth)`, no transform. **Reduced motion:** collapses to `1ms` via the
  token block; no `animation: none` rule needed, because it is a transition and its end state is
  the resting state.
- `Retry` calls the existing retry path — `onRetry` → `handleSend`
  (`web/components/chat/chat-pane.tsx:637`). No new send plumbing.

**One behaviour the send-motion slice replaces rather than adds to.** `failSend`
(`web/hooks/use-live-session.ts:1330-1344`) currently appends a synthetic *assistant* row reading
`Error: …` and leaves the user's own bubble looking successfully sent. That is the wrong shape:
the failure belongs to the message that failed. The send-motion slice moves the signal onto the user bubble and
removes the synthetic assistant row. Shipping both would give one event two cues in two voices.

### 1.5 Files, and where the code goes

| File | Change |
| --- | --- |
| `web/routes/globals.css` | `--danger-fill` in both theme blocks; `jinn-msg-send-in` keyframes; `.user-msg-bubble[data-msg-enter]` and the three `[data-send-state]` rules; the reduced-motion `animation: none`. |
| `web/components/chat/chat-messages.tsx:1018` | Add `data-send-state` / `data-msg-enter` attributes. Attribute-only — no net lines. |
| `web/hooks/use-live-session.ts:1315,1330` | `beginSend` marks `pending`; `failSend` marks the user message `failed` instead of appending an assistant row. Net-negative lines. |
| **new** `web/components/chat/message-send-state.ts` | ≤300 lines. Owns the `pending | sent | failed` derivation from `(message, pendingUserMessageRef, lastError)` and the retry dispatch. Where the tests live. |

Both capped files above are edited net-zero or net-negative. The new logic lands in the new
module.

---

## 2. Receive and streaming motion

Operator defect 2's other half, and the streaming behaviour behind defect 3. Owners:
**the send-motion slice** for the enter animation, **the scroll slice** for the scroll invariant it must not break.

### 2.1 Assistant enter animation

```css
.assistant-transcript[data-msg-enter] {
  animation: jinn-msg-receive-in var(--duration-slow) var(--ease-smooth) backwards;
}
@keyframes jinn-msg-receive-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
}
```

- **Duration** `var(--duration-slow)` = `260ms`. Slower than the send's `180ms` on purpose: the
  send is a response to the reader's own action and must feel immediate; the reply is something
  arriving, and arriving is allowed to take longer. It matches `jinn-comm-rise` at `240ms`
  (`web/routes/globals.css:806`) within a frame.
- **Easing** `var(--ease-smooth)`.
- **Distance** `4px`, no scale. This is the same figure and the same shape as `jinn-comm-rise`
  (`web/routes/globals.css:820`); the assistant column is left-aligned prose with no bubble
  chrome, and a scale on a full-width text block reads as a glitch.
- **Transform origin** not set. The animation has no scale, so origin has no effect; declaring one
  would be noise.

**The rule that decides whether it plays at all.** The animation runs **only when the row appears
without a preceding stream for that turn.** When `streamingText` was non-empty and the final
message replaces `StreamingBubble` (`web/components/chat/chat-messages.tsx:1469-1475`), the text
is already on screen and the swap plays **no** animation — re-fading text the reader is already
reading is the worst possible outcome here. The cases that do animate: a teammate callback, a
notification row, a non-streaming engine's reply, and a message arriving into a session the
reader has open but did not just prompt.

`StreamingBubble` and the final row already share prefix, shell and action-row footprint by
design (`web/components/chat/chat-messages.tsx:1066-1068`) so the swap does not move the first
line. That structural-parity rule stays binding.

**Reduced motion.** `animation: none`, same reasoning as §1.2 — the end state is the resting
state.

### 2.2 Invariant S — streaming growth may not move a detached reader

This is the assertable form of "streaming text growth must not jerk the scroll position". It is
**already implemented**; the reason it is written down is that the send-motion and scroll slices both touch the
transcript and this is the thing they must not regress.

Let `d = scrollHeight − scrollTop − clientHeight`, computed by `distanceFromBottom`
(`web/hooks/use-stick-to-bottom.ts:32-34`), and let `B = 56px` = `STICK_THRESHOLD_PX`
(`web/hooks/use-stick-to-bottom.ts:27`).

> **Invariant S.** For any commit that grows the transcript — a streaming token, an appended
> message, a media decode:
>
> **S1 (pinned).** If the reader is following, the commit ends pinned —
> `distanceFromBottom(el) === 0`, which reads back as `scrollTop === scrollHeight − clientHeight` —
> written synchronously in a layout effect before paint. Assert the readback, never the assigned
> value: `pinNow` writes `scrollTop = scrollHeight` (`web/hooks/use-stick-to-bottom.ts:123-126`)
> and the browser clamps that to the maximum scroll offset, so with `scrollHeight = 1000px` and
> `clientHeight = 200px` the pinned readback is `800px`, not `1000px`. A test scroller has to clamp
> the same way (`web/hooks/__tests__/use-scroll-anchor.test.tsx:33` already does) or the assertion
> passes on an unclamped stub while the real scroller is short.
>
> **S2 (detached).** If the reader is not following, `scrollTop` after the commit is bit-identical
> to `scrollTop` before it. No code path in the growth commit may write it.
>
> **S3 (the band).** Following engages when a *user* scroll ends at `d ≤ B` (`56px`) and did not
> move away from the bottom; it disengages when a user scroll moves away
> (`shouldFollow`, `web/hooks/use-stick-to-bottom.ts:37-39`, applied at `:181`). A programmatic
> scroll never changes it (`animatingRef`, `:171-182`).

Both halves are assertable in jsdom against `useStickToBottom` with a fake scroll element: drive
`streamingText`, read `scrollTop`. S2 is the one that has broken before and the one worth a test
that fails without the guard.

**The functions this binds to.** A slice may change how these are called; it may not change what
they mean.

| Function | File | Role |
| --- | --- | --- |
| `distanceFromBottom` | `web/hooks/use-stick-to-bottom.ts:32` | `d` |
| `shouldFollow` | `web/hooks/use-stick-to-bottom.ts:37` | the `B = 56px` band |
| `unreadDelta` | `web/hooks/use-stick-to-bottom.ts:42` | badge count, §4 |
| `useStickToBottom` growth effect | `web/hooks/use-stick-to-bottom.ts:225-244` | where S1/S2 are enforced |
| `pinNow` | `web/hooks/use-stick-to-bottom.ts:123-126` | the S1 write |
| `scrollToEnd` | `web/components/chat/chat-messages.tsx:1206-1209` | `scrollToIndex(count-1, {align:'end'})`, the virtualised bottom |
| `useTranscriptVirtualizer` | `web/components/chat/transcript-virtualizer.ts:75` | windowing, `overscan 8` |
| `captureVirtualAnchor` / `restoreVirtualAnchor` | `web/components/chat/transcript-virtualizer.ts:112,135` | prepend anchoring |
| `applyTranscriptAnchor` | `web/components/chat/transcript-virtualizer.ts:189` | the two-commit restore |
| `captureVisibleAnchor` / `restoreVisibleAnchor` | `web/lib/scroll-anchor.ts:36,60` | the non-virtualised path |

`OLDER_LOAD_THRESHOLD_PX = 900` (`web/lib/scroll-anchor.ts:16`) is the history-prefetch trigger
and is unchanged by anything here.

### 2.3 The streaming bubble stays outside the window

`StreamingBubble` renders outside the virtualised container
(`web/components/chat/chat-messages.tsx:1468`). That is deliberate: it has no stable group key,
and `getItemKey` must be a stable group id or an index-shift after a prepend describes the wrong
rows (`web/components/chat/transcript-virtualizer.ts:17-20`). Keep it outside.

The cost of that placement is §4's problem, and it is stated there with a budget:
`formatMessage(closePartialMarkdown(streamingText))` is memoised on `streamingText`
(`web/components/chat/chat-messages.tsx:1074-1077`), which changes on every token, so the whole
buffer re-formats per token.

### 2.4 Files, and where the code goes

| File | Change |
| --- | --- |
| `web/routes/globals.css` | `jinn-msg-receive-in` keyframes, `.assistant-transcript[data-msg-enter]`, its reduced-motion rule. |
| `web/components/chat/chat-messages.tsx:794` | `data-msg-enter` on the transcript div. Attribute-only. |
| `web/hooks/use-stick-to-bottom.ts` | No change expected. If Invariant S needs enforcement it goes here, and this file is **not** in the size baseline, so it has room. |
| **new** `web/components/chat/message-arrival.ts` | ≤300 lines. Owns "did this row arrive live, and was it preceded by a stream" for §1 and §2 both, extracted from the `arrivalsRef` block at `web/components/chat/chat-messages.tsx:1285-1309`. Extracting it is what pays for §1's attribute lines in that capped file. |

---

## 3. Chat-open transition

Operator defect 4 — *"when I open a chat it will scroll viciously to the bottom or at least try
to do it, sometimes it doesn't, so I have to manually click the down arrow."* Owner:
**the scroll slice**. The first-send variant of the same symptom belongs to **the first-send slice**; this section supplies its
target, not its fix.

### 3.1 The timeline

`t = 0` is the commit in which the tapped session becomes `selectedId`
(`web/routes/chat/page.tsx:1135`).

| Time | What happens | Enforced by |
| --- | --- | --- |
| `t = 0`, layout effect, before paint | The mount snap runs: `scrollTop = scrollHeight`. The bottom anchor becomes authoritative **here** — `followRef` is `true` from this instant, so every later growth commit pins. | `web/hooks/use-stick-to-bottom.ts:213-223` (`useLayoutEffect`) |
| `t = 0`, first paint | The transcript paints **already at the bottom**. Not scrolled there — painted there. | as above |
| `t = 0 → 180ms` | The pane fades and rises in: `jinn-chat-open`, `opacity 0 → 1` with `translateY(4px) → 0`, `var(--duration-base)` = `180ms`, `var(--ease-smooth)`. Opacity and transform only, so nothing reflows and the paint above is not delayed by it. | new rule, `web/routes/globals.css` |
| `t = 0` → settle | Late row measurements re-pin to the bottom. Some of these land after the opening paint: the content `ResizeObserver` is a `useEffect` (`web/hooks/use-stick-to-bottom.ts:256-267`), so it fires after a paint, not before one. They are allowed only as §3.2's settle exception — pinned-only, bottom-only, bounded. The window closes at the first commit where `virtualizer.getTotalSize()` is unchanged from the previous commit, or at `400ms` from `t = 0`, whichever comes first. | §3.2, over `web/components/chat/transcript-virtualizer.ts` + `web/hooks/use-stick-to-bottom.ts:256-267` |
| after settle | **The chat-open transition owns no further writes.** The transcript's standing rules resume and govern alone: a growth commit pins or holds under Invariant S, and the down-arrow scrolls on command. §3 is done. | §2.2, §4 |

On mobile (`<1024px`) the list→pane switch is a `hidden` / `flex` class toggle today with no
transition at all (`web/routes/chat/page.tsx:1101,1122`). `jinn-chat-open` applies there too, on
the same `180ms`. The list does not animate out — it is display-toggled, and cross-fading two
full-height panes on a phone costs a compositor layer for a transition nobody asked for.

### 3.2 Forbidden: a visible post-paint jump-scroll

A **visible post-paint jump-scroll** is a scroll write made after the browser has painted a frame
that changes which content sits under the reader's eye in the next one. That is the thing this
section forbids, and the word doing the work is *visible*.

**No code path may write `scrollTop`, or call `scrollTo` / `scrollToIndex` / `scrollIntoView`, on
the transcript scroller *in order to establish or correct the chat-open position*, after the
browser has painted the opening frame, except under the settle exception below.** If the correct
opening position is not known before paint, the transcript is not painted until it is.

The scoping clause carries weight and is not decoration. This section governs exactly one class of
write: the ones whose purpose is to put the reader where the open should have put them. It has
never been a prohibition on scrolling a chat. A write that serves the transcript's ongoing
behaviour — a pinned growth commit (§2.2 S1), a tap on the down-arrow (§4.4) — is not a chat-open
correction, so §3 does not reach it whatever the clock reads.

**The settle exception.** A re-pin during the settle window is the one post-paint write that is
not a visible jump-scroll, because it does not move the reader's frame of reference — it holds it.
A pinned reader is looking at the bottom edge of the newest row; the re-pin keeps that edge flush
with the viewport bottom while estimates below and above resolve. Remove it and the reader drifts
*upward* as the true total height grows past the estimate, which is the "sometimes it doesn't
reach the bottom" defect in §3.3 — the drift is what is visible, not the correction. The exception
holds only while all three conditions do:

1. **Pinned only.** `followRef.current` is `true`. A reader who has scrolled away owns the
   position; Invariant S2 (§2.2) forbids writing it and the settle window does not weaken that by
   one frame.
2. **Bottom only.** The write may only reduce `d` to `0`. No remembered offset, no row-relative
   target, no partial scroll — a write that lands anywhere other than the bottom has moved the
   reader, and that is a jump-scroll whatever triggered it.
3. **Bounded.** It stops at the settle condition in §3.1 — unchanged `virtualizer.getTotalSize()`,
   or `400ms` from `t = 0`, whichever comes first. When the window closes, §3 is finished with the
   transcript: a later write is judged by §2.2 and §4, not by this section. Closing the window ends
   the exception, not the transcript's right to scroll.

Before first paint, `measureElement` (`web/components/chat/chat-messages.tsx:1457`) writes its
measurements in a layout effect and a re-pin keyed on the resulting size lands in the same commit,
so nothing short is ever painted. After first paint the settle exception is the only route left to
a chat-open correction, and it is the three conditions or nothing.

One shipped path violates it today. `onContentReady` fires inside a `requestAnimationFrame`
(`web/components/chat/chat-pane.tsx:503-506`), and `handlePaneContentReady` then schedules
*another* `requestAnimationFrame` that writes a remembered `scrollTop`
(`web/routes/chat/page.tsx:698-703`). That is two frames after the ready commit — a post-paint
scroll by construction, and the visible jump. The settle exception does not cover it: it writes a
*remembered* offset rather than the bottom, failing condition 2, and it is keyed on a frame count
rather than on measured size, failing condition 3. The remembered position must move into the same
layout effect as the mount snap, or be dropped.

**Every write site, with one owner and one verdict.** A slice implementer reads this table instead
of inferring an answer from two rules at once. Each row is classified by exactly one section, and
no site appears under two.

| Write site | Phase | Verdict | Owned by |
| --- | --- | --- | --- |
| mount snap, `web/hooks/use-stick-to-bottom.ts:213-223` | before first paint | **required** | §3.1 |
| growth effect `:225-244`, pinned | any time, during settle or long after | **required** | §2.2 S1 |
| growth effect `:225-244`, detached | any time | **forbidden** | §2.2 S2 |
| viewport-resize RO `:246-254` / content RO `:256-267`, pinned | during settle | **allowed**, bottom-only | §3.2 settle exception |
| viewport-resize RO `:246-254` / content RO `:256-267`, pinned | after settle | **allowed**, bottom-only | §2.2 S1 |
| `visibilitychange` / `pageshow` resync `:269-282`, pinned | after settle | **allowed**, bottom-only | §2.2 S1 |
| `scrollToEnd` from the down-arrow, `web/components/chat/chat-messages.tsx:1206-1209` | any time | **allowed**, user-commanded | §4.4 |
| remembered-offset rAF, `web/components/chat/chat-pane.tsx:503-506` → `web/routes/chat/page.tsx:698-703` | after first paint | **forbidden** | §3.2 |

Row two is the one that settles the question this table exists to answer. A pinned reader receives
one streamed token at `t = 500ms`, past the `400ms` cutoff: that is a growth commit, so §2.2 S1
**requires** the pin and §3 never reaches it. The settle window closing ends §3's involvement; it
does not turn a required write into a forbidden one.

The last row is the defect §3 exists to kill, and the scoping above does not spare it. That write's
whole purpose is to establish the opening position, which puts it squarely inside the narrowed rule
— and even read as an ordinary transcript write it lands nowhere near the bottom, so §2.2 has no
clause that would permit it either.

### 3.3 The "sometimes it doesn't" case has a named cause

**Late row measurement in `web/components/chat/transcript-virtualizer.ts`.**

At `≥50` render groups the transcript virtualises (`VIRTUALIZE_THRESHOLD = 50`,
`web/components/chat/transcript-virtualizer.ts:32`). Rows enter at estimates — `140px` for a
plain message, `56px` for a tool row, `44px` for a dispatch row, `72px` for a burst, `56px` for a
folded region (`:38-43`) — and re-measure through `virtualizer.measureElement` as they mount
(`web/components/chat/chat-messages.tsx:1457`). The comment at `:37` is explicit that wrong
estimates are fine, because everything mounted re-measures.

`pinNow` writes `scrollTop = scrollHeight` (`web/hooks/use-stick-to-bottom.ts:123-126`) — a single
write against the *estimated* total height. When the real heights resolve larger than the
estimates, the true bottom moves further down and the view is left short. That is precisely the
open that needs a manual down-arrow, and it is why the failure is intermittent: it depends on how
far the estimates were wrong for the particular tail of that particular transcript.

**Ordering, not a retry.** On open, target the bottom through `scrollToEnd`
(`web/components/chat/chat-messages.tsx:1206-1209`) — `scrollToIndex(count - 1, { align: 'end' })`
re-targets as measurements land, which is exactly the property the comment at `:1203-1205`
records — rather than through `pinNow`'s single `scrollHeight` write. The `400ms` bound in §3.1 is
a stop condition on §3.2's settle window, keyed on measured size, not a timer that retries a scroll:
it exists so a long tail of image decodes cannot hold the view pinned against a reader who has
already started scrolling.

The gap above the virtual block — the `~80px` header padding, plus the older-page row — **is**
declared as `scrollMargin` (`web/components/chat/transcript-virtualizer.ts:25-34`), as of the scroll-margin change.
This section previously said not to add it, on the grounds that every offset the module compares is
a difference between two of the virtualizer's own numbers, where the shift cancels. That is true of
this module's own comparisons and false of the one virtual-core makes internally: deciding whether a
re-measured row sits above the reader, it tests the row's `start` — spacer coordinates — against the
scroller's real `scrollTop`. Undeclared, those are two coordinate systems off by exactly that gap,
so every row in the top `~80px` of the viewport read as one above the reader and took a scroll
correction the reader watched happen. Rows are positioned at `start - scrollMargin`, so declaring it
moves nothing on screen.

### 3.4 The first-send case — the first-send slice's target

Two independent unmounts blank the transcript on the first message of a new chat:

1. `web/routes/chat/page.tsx:1135` keys `ChatPane` by `selectedId ?? '__new__:…'`. The first send
   moves `selectedId` from `null` to a real id, so the pane, `useLiveSession` and
   `useStickToBottom` all remount. Only `pendingUserMessage`
   (`web/routes/chat/page.tsx:1154`) carries the bubble across.
2. `showSessionHydration` (`web/components/chat/chat-pane.tsx:515`) gates the transcript at
   `:630`, so while `hydrating` the transcript is unmounted and a centred spinner paints at
   `:605-609`.

**The target this spec sets, for the first-send slice to hit:** across a first send, the transcript element is
never unmounted and the user's bubble never leaves the screen. And the hydration spinner is a
*threshold*, not a default — it may appear only if no messages are available **250ms** after
`t = 0`. Below that, the previous frame holds. The first-send slice owns the mechanism; its own brief is
explicit that hiding the loading state is not an acceptable fix, and this target is compatible
with that: the requirement is that nothing unmounts, not that the spinner is suppressed.

### 3.5 Reduced motion

`jinn-chat-open` → `animation: none`. Its end state is the resting state, so the pane is simply
present on the first frame. Everything else in this section is scroll positioning, not motion: the
pin has always been an instant `scrollTop` write and is byte-identical in both modes. `scrollToEnd`
is called with `behavior` — on the open path it is always `'auto'`, never `'smooth'`, in both
modes. The reduced-motion reset already forces `scroll-behavior: auto` globally
(`web/routes/globals.css:1170`).

### 3.6 Files, and where the code goes

| File | Change |
| --- | --- |
| `web/routes/globals.css` | `jinn-chat-open` keyframes + rule + reduced-motion `animation: none`. |
| `web/components/chat/chat-pane.tsx:503-515,605,630` | Spinner becomes a 250ms threshold; `onContentReady`'s `rAF` removed. Net-negative lines. |
| `web/routes/chat/page.tsx:698-703` | Remembered-scroll restore moves out of its `rAF`. Net-negative lines. |
| `web/components/chat/chat-messages.tsx:1206` | Open path targets `scrollToEnd`. |
| **new** `web/components/chat/transcript-open.ts` | ≤300 lines. Owns the open sequence: mount snap, the bounded settle loop, and the remembered-position restore, all as layout-effect callbacks. Tests for the ordering live here. |

---

## 4. Scroll feel

Operator defect 3 — *"when I try to scroll on mobile it will abruptly stop instead of just
sliding naturally when I release my finger."* Owner: **the scroll slice**.

### 4.1 The native-scroll constraint, recorded as binding

**No JS momentum scroller. Not Lenis, not Locomotive, not a hand-rolled `requestAnimationFrame`
transform.** This is settled and is not reopened by this spec or by any slice under it.

The reasoning, from the earlier native-scroll research: native scroll on iOS is backed by `UIScrollView` and is
compositor-driven, so it survives a busy main thread. Every library of the Lenis family cancels
that and drives a transform from a main-thread `rAF` loop — and Apple caps `requestAnimationFrame`
at **60Hz** inside `WKWebView` by design, with no public API to lift it (WebKit bug 294338). A
hand-rolled scroller therefore runs at half the frame rate of the scroller it replaced and
inherits every main-thread stall. JS scroll animation typically consumes **15–30%** of the main
thread during an active scroll.

The conclusion this spec inherits: **smooth scroll is not a scroller we write. It is native scroll
plus frames cheap enough that the compositor never waits.**

Corollary, also binding: `scroll-behavior: smooth` is not restored globally. It was removed in
`9aa551dd` and stays removed.

### 4.2 What is already shipped — do not "add" it, and do not remove it

| Property | Value | Where |
| --- | --- | --- |
| `overscroll-behavior` | `contain` | `web/routes/globals.css:1218-1222` |
| `-webkit-overflow-scrolling` | `touch` | same rule |
| `overflow-anchor` | `auto` | `web/components/chat/chat-messages.tsx:1438` |
| chrome `backdrop-filter` | scoped to `[@media(pointer:fine)]` | shipped |

`overscroll-behavior: contain` does **not** remove the edge rubber-band the operator wants. It
stops the scroll *chaining* to the page — the element keeps its own bounce. A slice that reads
"rubber-band at the edges" in the scroll slice's acceptance and removes `contain` to get it would break the
thing the rule was added for. Stated here so that does not happen.

So §4 is not a CSS-addition task. Everything a naive fix would add is present.

### 4.3 The remaining suspect, with a measured budget

Per-token main-thread work during an active scroll. `StreamingBubble` re-formats its entire
buffer on every token: `formatMessage(closePartialMarkdown(streamingText))` is memoised on
`streamingText` (`web/components/chat/chat-messages.tsx:1074-1077`), and `streamingText` changes
per token. Cost is O(buffer length) per token, so it grows through a long reply — which matches
the symptom, since a flick that "stops dead" is a compositor waiting on a main thread that is busy.

Two numbers the scroll slice verifies against, on the target device, with a live stream running:

- **≤ 8ms** of main-thread work per token at p95, measured on a **4000-character** buffer.
- **No `long-animation-frame` entry > 50ms** during an active scroll.

A budget with no measurement is not a requirement; these are the measurements.

### 4.4 The down-arrow's rule

The control is `JumpToLatestButton` (`web/components/chat/jump-to-latest.tsx:43`).

**Appear / disappear, in px.**

| | Rule | Source |
| --- | --- | --- |
| Appear | A user scroll that moved away from the bottom **and** ends at `d > 56px`. | `56px` = `STICK_THRESHOLD_PX`, `web/hooks/use-stick-to-bottom.ts:27` |
| Disappear | A user scroll ending at `d ≤ 56px`, or a tap on the control. | `shouldFollow`, `:37-39` |
| Never toggled by | A programmatic scroll. | `animatingRef`, `:171-182` |

**This is a change, and it is deliberate.** Today `follow = movedAway ? false : shouldFollow(dist)`
(`web/hooks/use-stick-to-bottom.ts:183`) drives `showJump` directly, so *any* movement away
detaches — including a 1px drag at `d = 4px`, which shows an arrow offering to scroll the reader
four pixels. That is noise.

The change gates **only the affordance's visibility** on `d > 56px`. Follow-intent keeps its
current rule and detaches on any movement away, because the comment at
`web/hooks/use-stick-to-bottom.ts:10-12` records why it must: a freshly opened transcript resizes
for a second or two, and re-pinning below the band would undo a small scroll-up before the reader
ever cleared it. Follow-intent and the affordance are two decisions; today they share one flag,
and this separates them.

**Timings — adopted unchanged.**

| | Value | Source |
| --- | --- | --- |
| Enter | `jinn-jump-in` `160ms` `var(--ease-smooth)`, `opacity 0→1`, `translateY(8px)→0`, `scale(0.96)→1` | `web/components/chat/jump-to-latest.tsx:64`, keyframes at `web/components/chat/chat-messages.tsx:1516-1523` |
| Exit | `jinn-jump-out` `140ms` `var(--ease-snappy)`, `opacity 1→0`, `translateY(0)→6px`, `scale(1)→0.98` | same |
| Unmount delay | `JUMP_EXIT_MS = 140` | `web/components/chat/jump-to-latest.tsx:4` |

**No change.** The pair already follows the system's "each exit is quicker than its entrance" rule
(`web/routes/globals.css:265-269`), and the operator's complaint was about *needing* the arrow on
open, not about how it appears. `JUMP_EXIT_MS` and the CSS `140ms` must stay equal — they are the
same duration expressed twice, and a slice that changes one changes both.

These two are the only literal millisecond values this spec endorses rather than tokens. They are
grandfathered because they ship and work; anything new in §§1–3 uses `var(--duration-*)`.

**Geometry — unchanged.** `40 × 40px` on coarse pointers, `36 × 36px` under
`[@media(pointer:fine)]`, `bottom: 16px`, horizontally centred
(`web/components/chat/jump-to-latest.tsx:74`). `40px` clears the `≥34px` tap-target rule. The
unread badge and its `99+` cap are unchanged (`unreadDelta`,
`web/hooks/use-stick-to-bottom.ts:42`).

### 4.5 Reduced motion

§4 introduces no animation. The existing control already branches on
`usePrefersReducedMotion` (`web/components/chat/jump-to-latest.tsx:6-17`): under reduce it swaps
opacity with no keyframes and shortens the unmount timer to `1ms`
(`web/components/chat/jump-to-latest.tsx:36,62-64`). Unchanged, and the branch stays — it is the
one place a `both`-filled animation would otherwise strand the control mounted.

### 4.6 Files, and where the code goes

| File | Change |
| --- | --- |
| `web/hooks/use-stick-to-bottom.ts:183-196` | Separate `showJump` from `followRef`; gate the affordance on `d > 56px`. Not in the size baseline — it has room. |
| `web/components/chat/chat-messages.tsx:1069-1078` | Reduce per-token formatting cost. Net-neutral or negative; this file has zero headroom. |
| **new** `web/components/chat/streaming-format.ts` | ≤300 lines. Owns incremental formatting of the streaming buffer — the extraction that makes the 8ms budget reachable and gives it a test surface. |
| `web/routes/globals.css` | No change. Everything §4 would add is already there (§4.2). |

---

## 5. Bubble type scale

Operator defect 5 — *"the font sizes ... refining them if they're too small for user messages and
for AI messages also, but do that only if you think it is necessary."* Owner: **the typography slice**.

Explicit decisions for both bubbles follow. The typography slice's brief says a "no change" outcome closes it
immediately with the rationale recorded; the decisions below are **change** for the user bubble
and for leading on both, so the typography slice executes rather than closes.

### 5.1 What ships today

| | User | Assistant |
| --- | --- | --- |
| Element | `.user-msg-bubble`, `web/components/chat/chat-messages.tsx:1018` | `.assistant-transcript`, `web/components/chat/chat-messages.tsx:794` |
| Size token | `--text-subheadline` | `--text-body` |
| Resolved | `clamp(0.875rem, 0.8366rem + 0.1577vw, 0.9375rem)` → `14px` @390px, `15px` @1024px | `clamp(1rem, 0.9616rem + 0.1577vw, 1.0625rem)` → `16px` @390px, `17px` @1024px |
| Leading applied | `--leading-relaxed` = `1.65` | `--leading-relaxed` = `1.65` |
| Leading the scale binds | `--text-subheadline--line-height` = `1.45` | `--text-body--line-height` = `1.47` |
| Weight | `--weight-medium` | inherited regular |
| Measure | `max-width: 90%` (`82%` ≥1024px), `web/components/chat/chat-messages.tsx:1525,1530` | `100%` of the column |
| Column | `--chat-measure: 64rem` = `1024px`, `web/routes/globals.css:300` | same |

Scale definitions: `web/routes/globals.css:171-208`. `--leading-relaxed`: `web/routes/globals.css:223`.

### 5.2 Decision — user bubble: **CHANGE**, `--text-subheadline` → `--text-body`

`text-[length:var(--text-subheadline)]` becomes `text-[length:var(--text-body)]` at
`web/components/chat/chat-messages.tsx:1018`.

Effect: `14px → 16px` at 390px, `15px → 17px` at 1024px.

Reasoning:

- The operator's own words render one full rung of the scale **smaller** than the assistant's
  reply, in the same conversation, in the same column. That asymmetry is very likely the whole of
  the "font sizes feel small" instinct, and no amount of adjusting the assistant side fixes it.
- HIG puts conversational message text at **Body**. Subheadline is a secondary-metadata step —
  correct for a timestamp or a session label, not for the thing the reader typed.
- `16px` is the floor the rest of the chat reads at on a 390px phone. `14px` is below it.
- The `--weight-medium` on the bubble was compensating for the small size. It is **kept** — at
  Body it stops being compensation and becomes what it should always have been: the mark that
  distinguishes the operator's voice inside a shared column. Explicit decision, no change.

### 5.3 Decision — assistant bubble: **NO CHANGE to size**, `--text-body` stays

Reasoning:

- It is already the HIG conversational step, and the same step the user bubble is being raised to
  in §5.2. Raising both would restore the asymmetry at a higher altitude and solve nothing.
- Assistant prose is the widest-measure text on the screen. At `17px` a `64rem` column already
  runs to roughly 90 characters per line, at the top of the comfortable range. Increasing the size
  narrows the character count, but by making the whole page heavier rather than by fixing the
  measure — which is the actual lever, and is §5.5.

### 5.4 Decision — leading, both bubbles: **CHANGE**, drop the `--leading-relaxed` override

Remove `leading-[var(--leading-relaxed)]` from both
`web/components/chat/chat-messages.tsx:794` and `:1018`, so each element takes the leading its own
type step binds: `1.47` for `--text-body`. That figure is also `--leading-normal`
(`web/routes/globals.css:222`) — this is a removal, not a new value.

Reasoning:

- `1.65` predates the fluid type scale, which binds a leading to every step
  (`web/routes/globals.css:171-208`). Keeping the override means the one place the scale is
  overridden is the one place the scale matters most.
- Size and leading are one decision, not two. Raising the user bubble to `16px` while leaving
  `1.65` would grow the line box by `3.3px` per line and make short messages read as loose blocks.

The arithmetic is why this pairing is nearly free on the user side and is the real gain on the
assistant side:

| | line box now | line box after | delta |
| --- | --- | --- | --- |
| User @390px | `14 × 1.65 = 23.10px` | `16 × 1.47 = 23.52px` | **+0.42px** |
| User @1024px | `15 × 1.65 = 24.75px` | `17 × 1.47 = 24.99px` | **+0.24px** |
| Assistant @390px | `16 × 1.65 = 26.40px` | `16 × 1.47 = 23.52px` | **−2.88px** |
| Assistant @1024px | `17 × 1.65 = 28.05px` | `17 × 1.47 = 24.99px` | **−3.06px** |

The user's glyphs grow `2px` while the row height moves less than half a pixel. The assistant's
paragraphs tighten by about 11% per line without the type changing at all.

**Two containment notes, both already true — verify, do not "fix".** Code blocks set their own
size and `leading-normal` (`web/components/chat/message-markdown.tsx:162`) and tables set
`leading-[1.6]` (`:217`), so neither inherits the change. Long-URL and long-token wrapping is
handled by `overflow-wrap: break-word; word-break: break-word` on both bubble classes
(`web/components/chat/chat-messages.tsx:1524-1526`) and is unaffected by size.

**One consequence the typography slice must re-check.** Every assistant row gets shorter, which changes how
wrong `PLAIN_MESSAGE_SIZE = 140` (`web/components/chat/transcript-virtualizer.ts:38`) is. No code
change is required — the estimate self-corrects on measure (`:37`) — but §3.3's late-measurement
case is exactly the thing sensitive to estimate error, so the typography slice re-runs §3's open-at-bottom
check after the type change rather than assuming §3 still holds.

### 5.5 Decision — measure: **NO CHANGE**, `--chat-measure: 64rem` stays

`64rem` = `1024px`, `web/routes/globals.css:300`. `.user-msg-bubble` keeps `max-width: 90%` and
`82%` at `≥1024px`.

Reasoning: at `17px` this column runs to roughly 90 characters, wider than the 60–75 usually cited
as comfortable. But it is the shipped, operator-approved reading width; the operator's complaint
was that text is too *small*, not that lines are too long; and narrowing it changes the look of
every desktop screenshot in the product. Considered and declined here. If it is worth doing it is
its own Todo with its own screenshot pass, not a rider on a font-size change.

### 5.6 Reduced motion

§5 introduces no animation and no transition. Type size and leading are static properties; there
is no motion behaviour to state, and none should be added — animating a font-size change would be
a layout-driving animation, which the design system does not do.

### 5.7 Files, and where the code goes

| File | Change |
| --- | --- |
| `web/components/chat/chat-messages.tsx:1018` | `--text-subheadline` → `--text-body`; drop `leading-[var(--leading-relaxed)]`. |
| `web/components/chat/chat-messages.tsx:794` | Drop `leading-[var(--leading-relaxed)]`. |
| `web/routes/globals.css` | No change. Every token this decision uses already exists in both theme blocks. |

Both edits are token swaps and class removals on existing lines — net-zero or net-negative in a
file with zero ratchet headroom, so §5 needs no new module. It is the only section that does not.

**Screenshot gate.** The typography slice verifies at `1440×900` and `390×844`, in **both** light and dark,
including a transcript with a code block, an inline-code run, a bare long URL, and a
single-word message. One theme or one breakpoint is a failed gate, not a partial one.
