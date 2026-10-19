#!/usr/bin/env bash
# Screenshots of the web UI from a throwaway, seeded sandbox, for before/after
# evidence on pull requests. See e2e/ui-capture/README.md.
#
#   scripts/capture-ui.sh <out-dir> [screen ...]
#
# Environment:
#   JINN_CAPTURE_REPO   the built checkout to photograph (default: this one). Point it at a
#                       worktree of the base branch for the "before" set.
#   JINN_CAPTURE_PORT   sandbox port, at or above 8060 (default 8062).
#   JINN_CAPTURE_TMP    where the throwaway host home goes (default /tmp).
#   JINN_CAPTURE_NODE   node binary (default: the one beside pnpm).
#   JINN_CAPTURE_BROWSER firefox (default) or chromium; use the same one for before and after.
#   JINN_CAPTURE_KEEP_DRI set to leave /dev/dri visible to Chromium (see below).
#   JINN_CAPTURE_TOOL    the script in e2e/ui-capture to run against the sandbox: capture.mjs
#                        (default), perf.mjs (scroll frame times) or blur-count.mjs.
#   JINN_CAPTURE_MESSAGES pad the chat to this many messages (perf.mjs wants a long transcript).
set -euo pipefail

unset JINN_HOME JINN_PORT JINN_HOST JINN_INSTANCE JINN_GATEWAY_URL JINN_GATEWAY_TOKEN JINN_SESSION_ID

SCRIPT_REPO="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${JINN_CAPTURE_REPO:-$SCRIPT_REPO}" && pwd)"
HELPER="$SCRIPT_REPO/scripts/jinn-sandbox.sh"
CAPTURE_DIR="$SCRIPT_REPO/e2e/ui-capture"
PORT="${JINN_CAPTURE_PORT:-8062}"
TMP_BASE="${JINN_CAPTURE_TMP:-/tmp}"
INSTANCE="ui-capture"

OUT="${1:-}"
[[ -n "$OUT" ]] || { echo "usage: capture-ui.sh <out-dir> [screen ...]" >&2; exit 2; }
shift
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

PNPM_BIN="$(command -v pnpm || true)"
NODE_BIN="${JINN_CAPTURE_NODE:-${PNPM_BIN:+$(dirname "$PNPM_BIN")/node}}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "set JINN_CAPTURE_NODE to a node binary" >&2; exit 2; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 8060 )) || [[ "$PORT" == "7777" || "$PORT" == "7788" ]]; then
  echo "JINN_CAPTURE_PORT must be an integer at or above 8060 and cannot be 7777 or 7788" >&2
  exit 2
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "port $PORT is already in use" >&2
  exit 2
fi
[[ -f "$REPO/packages/jinn/dist/web/index.html" ]] || { echo "$REPO has no web build; run pnpm build there first" >&2; exit 2; }

ROOT="$(mktemp -d "$TMP_BASE/jinn-ui-capture.XXXXXX")"
HOST_HOME="$ROOT/host"
SANDBOX_HOME="$HOST_HOME/.jinn-$INSTANCE"
BASE_URL="http://127.0.0.1:$PORT"
STARTED=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$STARTED" -eq 1 ]]; then
    env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" stop "$INSTANCE" >/dev/null 2>&1 || status=3
    env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" destroy "$INSTANCE" --yes >/dev/null 2>&1 || status=3
  fi
  if [[ "$ROOT" == "$TMP_BASE"/jinn-ui-capture.* && -d "$ROOT" ]]; then rm -rf "$ROOT"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$HOST_HOME"
env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" create "$INSTANCE" --port "$PORT" --seed
# The org screens need the seeded org; every other screen keeps its fixtures unchanged.
if [[ "${JINN_CAPTURE_TOOL:-capture.mjs}" == "capture.mjs" ]] && { [[ $# -eq 0 ]] || printf '%s\n' "$@" | grep -q '^org-'; }; then
  export JINN_CAPTURE_SEED_ORG=1
fi
# Skills, cron and notes screens read their own fixtures (seed-pages.mjs), written the same way.
if [[ "${JINN_CAPTURE_TOOL:-capture.mjs}" == "capture.mjs" ]] && { [[ $# -eq 0 ]] || printf '%s\n' "$@" | grep -Eq '^(skills|skill-detail|cron|cron-detail|notes|notes-editor)$'; }; then
  export JINN_CAPTURE_SEED_PAGES=1
fi
"$NODE_BIN" "$CAPTURE_DIR/seed.mjs" db "$SANDBOX_HOME" "$REPO"
STARTED=1
env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" start "$INSTANCE"
"$NODE_BIN" "$CAPTURE_DIR/seed.mjs" api "$SANDBOX_HOME" "$BASE_URL" "$REPO"

# Headless Chromium renders in software, but its GPU process still opens /dev/dri. On a host whose
# GPU driver is wedged that open blocks in the kernel, and the page's main thread then waits on the
# GPU process forever (any canvas drawing, WebGL or screenshot hangs). Hiding the device node makes
# Chromium fall back to software cleanly, so run it with an empty /dev/dri when bwrap is available.
RUN=()
if [[ "${JINN_CAPTURE_BROWSER:-firefox}" == "chromium" && -z "${JINN_CAPTURE_KEEP_DRI:-}" && -e /dev/dri ]]; then
  if command -v bwrap >/dev/null 2>&1; then
    RUN=(bwrap --dev-bind / / --tmpfs /dev/dri)
  else
    echo "capture-ui: bwrap not found; Chromium keeps /dev/dri and may hang on a host with a wedged GPU driver" >&2
  fi
fi

cd "$SCRIPT_REPO"
${RUN[@]+"${RUN[@]}"} "$NODE_BIN" "$CAPTURE_DIR/${JINN_CAPTURE_TOOL:-capture.mjs}" "$SANDBOX_HOME" "$BASE_URL" "$OUT" "$@"
