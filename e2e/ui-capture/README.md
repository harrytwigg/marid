# UI captures: before/after evidence for pull requests

Every pull request that changes how the web UI looks carries the same
evidence: each affected screen in light and dark, at desktop (1440×900) and
narrow (390×844) widths, before and after, laid out as one comparison sheet
per screen.

## What runs

- `scripts/capture-ui.sh` creates a throwaway sandbox gateway (its own port,
  its own temporary home, no engine credentials), seeds it with neutral
  fixtures, photographs the screens, and destroys the sandbox on exit.
- `seed.mjs` is the fixture set: one chat with a short markdown conversation
  that ends on a message naming the first Todo (so there is a mention to
  hover), and six Todos across the board's columns. Every string is generic,
  because the images go on public pull requests.
- `screens.mjs` lists the screens, themes and viewports. Add a screen here
  when a change touches one that is not listed. A screen that only makes sense
  at one width (the nav rail and the Todo mention's glance are desktop only)
  names it with `viewports: ['desktop']`; `prepare(page)` drives the page into
  the state to photograph, by the pointer or by a real Tab and focus.
- `capture.mjs` takes the photographs. It fails a screen that never shows its
  fixture text, throws a page error, or shows the sandbox token or anything
  shaped like an id.
- `sheet.mjs` pairs a `before` and an `after` directory into one sheet per
  screen.

## Recipe

```sh
# 1. The base: a detached worktree of main, built once.
git worktree add --detach ../base origin/main
(cd ../base && pnpm install && pnpm build)

# 2. Before, from the base build; after, from your branch's build.
JINN_CAPTURE_REPO=../base scripts/capture-ui.sh shots/before chat settings
pnpm build && scripts/capture-ui.sh shots/after chat settings

# 3. One sheet per screen, attached to the PR.
node e2e/ui-capture/sheet.mjs shots/before shots/after shots/sheets
gh pr edit <PR> \
  --attach './shots/sheets/chat.png#Chat: before and after, light and dark, desktop and narrow' \
  --attach './shots/sheets/settings.png#Settings: before and after, light and dark, desktop and narrow'
```

Name only the screens the change affects; with no names every screen is
captured. Keep the shots out of the repository.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `JINN_CAPTURE_REPO` | this checkout | The built checkout to photograph. |
| `JINN_CAPTURE_PORT` | `8062` | Sandbox port, at or above 8060. |
| `JINN_CAPTURE_TMP` | `/tmp` | Where the throwaway host home goes. |
| `JINN_CAPTURE_NODE` | node beside pnpm | Node binary for the sandbox and scripts. |
| `JINN_CAPTURE_BROWSER` | `firefox` | `firefox` or `chromium`. Use the same one for both sides. |
| `JINN_CAPTURE_KEEP_DRI` | unset | Set to leave `/dev/dri` visible to Chromium. |
| `JINN_CAPTURE_TRANSPARENCY` | unset | `reduced` photographs with Reduced selected in the persisted settings, checks the root was marked at DOMContentLoaded, and keeps first-paint frames in `firstpaint/`. Use a separate out-dir. |
| `JINN_CAPTURE_MESSAGES` | unset | Pads the seeded chat with generic filler to this many messages. The `chat-long` screen (the thread scrolled to the middle, so text passes under the glass chrome) is only captured when it is set, and the `chat` screen needs it unset. |
| `JINN_CAPTURE_TOOL` | `capture.mjs` | The script to run against the sandbox: `capture.mjs`, `blur-count.mjs` or `perf.mjs` (below). |
| `JINN_SHEET_LABELS` | `Before,After` | Column names for `sheet.mjs`, e.g. `Firefox,Chromium` to compare two browsers. |

Firefox is the default. Both render `backdrop-filter` and `light-dark()`.

Headless Chromium still opens `/dev/dri` from its GPU process. On a host whose
GPU driver is wedged (`nvidia-smi` cannot find the device) that open blocks in
the kernel, and anything that needs the GPU process hangs the page: the app's
emoji favicon draws on a canvas, so every route freezes, as does WebGL or a
screenshot. With `JINN_CAPTURE_BROWSER=chromium` the script therefore runs the
capture under `bwrap --dev-bind / / --tmpfs /dev/dri`, which makes Chromium
fall back to software rendering. It needs `bwrap` with unprivileged user
namespaces; without `bwrap` a warning is printed and the device stays visible,
and where `bwrap` cannot create the sandbox the run fails with its error. On a
host with a working GPU the sandbox masks it (captures are software-rendered
either way); set `JINN_CAPTURE_KEEP_DRI=1` to skip it.

Every capture also gets an axe pass (`@axe-core/playwright`, WCAG 2 A and AA).
It only reports: a line per capture on the console and `axe.json` in the
out-dir (rule, impact, node count and the first selectors). Violations never
fail the run. "To review" counts are axe's incomplete results, which includes
text on gradients and translucent surfaces that it cannot resolve; the contrast
unit test in `packages/web/src/routes/__tests__/glass-identity.test.ts` covers
those.

Captures run with reduced motion, so a sheet compares states rather than
frames of a transition.

## Blur budget and scroll frame times

Two more tools run in the same sandbox, through `JINN_CAPTURE_TOOL`:

- `blur-count.mjs` opens the chat in each theme and width, with the thread at
  rest and scrolled up, and lists every element whose computed
  `backdrop-filter` is not `none`: all of them in the DOM and the ones visible
  at once. On desktop it also opens the nav rail's label and the Todo mention's
  glance, one at a time, and counts again: an open overlay is one more surface
  within the same budget, and none may blur under Reduced. It exits non-zero over 3 visible blurred surfaces, over a 32px
  radius, or any blur at all under Reduced or a coarse pointer (Chromium).
- `perf.mjs` (Chromium only) scrolls a long transcript up and down with real
  wheel gestures at 4× CPU throttle and records the gap between animation
  frames, printing the median and 95th percentile per run. Set
  `JINN_CAPTURE_MESSAGES=400`. It writes `perf.json` with every frame gap, so
  runs from several launches can be pooled; run the two builds alternately
  (before, after, before, after) so host load drifts across both. With
  `/dev/dri` hidden this is software raster, where a blur costs more than on a
  GPU: compare the builds with each other, not with a target. `JINN_PERF_RUNS`,
  `JINN_PERF_THROTTLE` and `JINN_PERF_VARIANTS` (for example
  `dark-desktop,dark-narrow`) tune it.

Headless Firefox does not render `backdrop-filter` at all, so a Firefox sheet
shows the glass tint without its blur; judge the blur in a Chromium sheet.
