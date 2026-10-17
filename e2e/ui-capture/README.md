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
  and six Todos across the board's columns. Every string is generic, because
  the images go on public pull requests.
- `screens.mjs` lists the screens, themes and viewports. Add a screen here
  when a change touches one that is not listed.
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

Firefox is the default. Both render `backdrop-filter` and `light-dark()`.

Headless Chromium still opens `/dev/dri` from its GPU process. On a host whose
GPU driver is wedged (`nvidia-smi` cannot find the device) that open blocks in
the kernel, and anything that needs the GPU process hangs the page: the app's
emoji favicon draws on a canvas, so every route freezes, as does WebGL or a
screenshot. With `JINN_CAPTURE_BROWSER=chromium` the script therefore runs the
capture under `bwrap --dev-bind / / --tmpfs /dev/dri`, which makes Chromium
fall back to software rendering. It needs `bwrap`; without it a warning is
printed and the device stays visible.

Captures run with reduced motion, so a sheet compares states rather than
frames of a transition.
