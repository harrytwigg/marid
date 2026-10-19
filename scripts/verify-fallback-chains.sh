#!/usr/bin/env bash
# Throwaway gateway with fake providers, and the fallback chain scenarios driven against it.
#
#   scripts/verify-fallback-chains.sh [--mode run|server|both] [--only a,b] [--pending a,b]
#                                     [--port N] [--keep] [--retain DIR] [--skip-build] [--strict]
#   scripts/verify-fallback-chains.sh --teardown <verify root printed by --keep>
#
# Nothing here uses real usage or quota. Only the upstream providers are fake: the real
# gateway, config loader, runner and web run against a stub `claude` (scripts/fake-providers)
# and a stub `opencode` (the engine tests' fixture), both steered by one scenario file and
# both appending to one ledger. The instance gets a temporary JINN_HOME, HOME and XDG dirs,
# two fake Claude profile directories (A and B) declared under engines.claude.accounts, the
# stubs as absolute `engines.<engine>.bin`, and a network guard that refuses (and logs) any
# connection that is not loopback. It runs under `env -i`, so nothing of the caller's
# environment (its Claude profile, API keys, instance variables) reaches it.
#
# Refused before anything starts: a port below 8060 or the live gateway ports, and any path
# (instance home, host home, profile directory) outside the temporary verification root or
# inside an operator home.
#
#   --mode        which opencode mode the instance runs in: run, server, or both (default)
#   --only        scenario ids to run, e.g. a,f (default: all)
#   --pending     scenarios that wait on runtime work not yet merged: their result is
#                 reported, never failed (default: none); a pending scenario that
#                 passes is reported as such, and --strict fails the run on it
#   --port        gateway port, 8060 or above (default: JINN_VERIFY_PORT, else a free one)
#   --keep        leave the last instance up for screenshots and print how to tear it down
#   --retain DIR  copy the ledger, logs and results there at the end
#   --skip-build  reuse the gateway repo's existing build
#
# Environment: JINN_VERIFY_NODE_BIN (node to run everything with, default the one beside pnpm),
# JINN_VERIFY_TMP_ROOT (default /tmp), JINN_VERIFY_GATEWAY_REPO (a checkout to run the gateway
# from, e.g. main, with this checkout's fakes and scenarios).
set -euo pipefail

# The caller's environment may name a gateway instance (home, port, identity). None of it is
# inert here, so it is dropped before anything reads it, and the instance starts under `env -i`.
unset JINN_HOME JINN_PORT JINN_HOST JINN_INSTANCE JINN_GATEWAY_URL JINN_GATEWAY_TOKEN JINN_SESSION_ID \
  JINN_SESSION_CAPABILITY JINN_TAKE_PORT JINN_BINDING_HOME JINN_HOME_IDENTITY CLAUDE_CONFIG_DIR

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GATEWAY_REPO="$(cd "${JINN_VERIFY_GATEWAY_REPO:-$REPO}" && pwd -P)"
HELPER="$REPO/scripts/jinn-sandbox.sh"
DRIVER_DIR="$REPO/scripts/verify-fallback-chains"
INSTANCE="fallback-chains"
MODE="both"; ONLY=""; PENDING=""; PORT="${JINN_VERIFY_PORT:-}"; KEEP=0; RETAIN=""; SKIP_BUILD=0; STRICT=0; TEARDOWN=""

die() { echo "verify-fallback-chains: $1" >&2; exit "${2:-2}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:?--mode needs run, server or both}"; shift 2 ;;
    --only) ONLY="${2:?--only needs scenario ids}"; shift 2 ;;
    --pending) PENDING="${2-}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --retain) RETAIN="${2:?--retain needs a directory}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --strict) STRICT=1; shift ;;
    --teardown) TEARDOWN="${2:?--teardown needs the verification root}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done
[[ "$MODE" == run || "$MODE" == server || "$MODE" == both ]] || die "--mode is run, server or both"

PNPM_BIN="$(command -v pnpm || true)"
NODE_BIN="${JINN_VERIFY_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  # The node beside pnpm when there is one (the pinned build), else the first on PATH.
  if [[ -n "$PNPM_BIN" && -x "$(dirname "$PNPM_BIN")/node" ]]; then NODE_BIN="$(dirname "$PNPM_BIN")/node"; else NODE_BIN="$(command -v node || true)"; fi
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node not found; set JINN_VERIFY_NODE_BIN"
NODE_DIR="$(dirname "$NODE_BIN")"
TMP_BASE="$(cd "${JINN_VERIFY_TMP_ROOT:-/tmp}" && pwd -P)"
ACCOUNT_HOME="$("$NODE_BIN" -e 'process.stdout.write(require("node:fs").realpathSync.native(require("node:os").userInfo().homedir))')"

port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

# Refuses a path that could belong to a real instance: outside the temporary root, or an
# operator home (the account's own home, ~/.jinn*, ~/.claude*).
refuse_unless_temporary() {
  local label="$1" path="$2" resolved
  resolved="$("$NODE_BIN" -e 'const fs=require("node:fs"),p=require("node:path");let d=process.argv[1];const tail=[];while(!fs.existsSync(d)){tail.unshift(p.basename(d));d=p.dirname(d)}process.stdout.write(p.join(fs.realpathSync.native(d),...tail))' "$path")"
  case "$resolved" in
    "$VERIFY_ROOT"/*|"$VERIFY_ROOT") ;;
    *) die "refusing $label $resolved: it is outside the temporary verification root $VERIFY_ROOT" ;;
  esac
  case "$resolved" in
    "$ACCOUNT_HOME"/.jinn|"$ACCOUNT_HOME"/.jinn/*|"$ACCOUNT_HOME"/.jinn-*|"$ACCOUNT_HOME"/.claude|"$ACCOUNT_HOME"/.claude/*|"$ACCOUNT_HOME"/.claude-*)
      die "refusing $label $resolved: it is inside an operator home" ;;
  esac
}

check_port() {
  [[ "$1" =~ ^[1-9][0-9]{3,4}$ ]] || die "port must be an integer at or above 8060: $1"
  (( $1 >= 8060 && $1 <= 65535 )) || die "port must be between 8060 and 65535: $1"
  [[ "$1" != "7777" && "$1" != "7788" ]] || die "refusing port $1: it belongs to a live gateway" # footgun: ok this refusal is the point of the check
  if port_listening "$1"; then die "port $1 is already in use"; fi
}

# The instance's own environment: `env -i` plus exactly this.
instance_env() {
  env -i PATH="$VERIFY_ROOT/bin:$NODE_DIR:/usr/bin:/bin" HOME="$HOST_HOME" LANG=C.UTF-8 TERM=dumb TMPDIR="$VERIFY_ROOT/tmp" \
    XDG_CONFIG_HOME="$HOST_HOME/.config" XDG_DATA_HOME="$HOST_HOME/.local/share" XDG_CACHE_HOME="$HOST_HOME/.cache" XDG_STATE_HOME="$HOST_HOME/.local/state" \
    FAKE_PROVIDER_OPENCODE_MODELS="own-provider/model-own,x-provider/model-x,y-provider/model-y" \
    FAKE_PROVIDER_SCENARIO="$VERIFY_ROOT/scenario.json" FAKE_PROVIDER_LEDGER="$VERIFY_ROOT/ledger.jsonl" FAKE_PROVIDER_NET_LOG="$VERIFY_ROOT/network-refusals.jsonl" \
    JINN_CLAUDE_USAGE_API=off NODE_OPTIONS="--require $DRIVER_DIR/network-guard.cjs" JINN_REPO="$GATEWAY_REPO" JINN_SANDBOX_NODE_BIN="$NODE_BIN" "$@"
}

sandbox() { instance_env "$HELPER" "$@"; }

teardown_instance() {
  local root="$1"
  # shellcheck disable=SC1091
  source "$root/instance.env"
  sandbox stop "$INSTANCE" >/dev/null 2>&1 || true
  for _ in {1..20}; do port_listening "$PORT" || break; sleep 0.25; done
  port_listening "$PORT" && die "listener remains on port $PORT" 3
  sandbox destroy "$INSTANCE" --yes >/dev/null 2>&1 || true
}

if [[ -n "$TEARDOWN" ]]; then
  VERIFY_ROOT="$(cd "$TEARDOWN" && pwd -P)"
  [[ -f "$VERIFY_ROOT/instance.env" && "$VERIFY_ROOT" == "$TMP_BASE"/jinn-fallback-chains.* ]] || die "$TEARDOWN is not a verification root this script made"
  # shellcheck disable=SC1091
  source "$VERIFY_ROOT/instance.env"
  teardown_instance "$VERIFY_ROOT"
  rm -r "$VERIFY_ROOT"
  echo "Tore down the instance and removed $VERIFY_ROOT"
  exit 0
fi

[[ -x "$HELPER" ]] || die "sandbox helper not found: $HELPER"
# NODE_OPTIONS carries the guard's path unquoted; a space would make node drop the option and the guard never load.
[[ "$DRIVER_DIR" != *[[:space:]]* ]] || die "the checkout path must not contain whitespace: $DRIVER_DIR"
[[ -f "$GATEWAY_REPO/packages/jinn/package.json" ]] || die "JINN_VERIFY_GATEWAY_REPO is not a checkout: $GATEWAY_REPO"
if [[ -z "$PORT" ]]; then
  for candidate in $(seq $((8060 + RANDOM % 100)) 8199); do port_listening "$candidate" || { PORT="$candidate"; break; }; done
  [[ -n "$PORT" ]] || die "no free port between 8060 and 8199"
fi
check_port "$PORT"

if (( ! SKIP_BUILD )); then
  [[ -n "$PNPM_BIN" ]] || die "pnpm is required to build (or pass --skip-build)"
  echo "Building $GATEWAY_REPO"
  ( cd "$GATEWAY_REPO" && PATH="$NODE_DIR:$PATH" nice -n 10 pnpm build >/dev/null ) || die "build failed" 1
fi
[[ -f "$GATEWAY_REPO/packages/jinn/dist/bin/jinn.js" ]] || die "no build at $GATEWAY_REPO/packages/jinn/dist; drop --skip-build"

VERIFY_ROOT="$(mktemp -d "$TMP_BASE/jinn-fallback-chains.XXXXXX")"
VERIFY_ROOT="$(cd "$VERIFY_ROOT" && pwd -P)"
mkdir -p "$VERIFY_ROOT/tmp" "$VERIFY_ROOT/artifacts" "$VERIFY_ROOT/bin"
# `jinn setup` pre-caches `npx skills`, a registry fetch: npx and npm do nothing in the instance.
for stub in npx npm; do printf '#!/bin/sh\necho "verify-fallback-chains: %s is disabled in the instance" >&2\nexit 0\n' "$stub" > "$VERIFY_ROOT/bin/$stub"; chmod +x "$VERIFY_ROOT/bin/$stub"; done
: > "$VERIFY_ROOT/ledger.jsonl"; : > "$VERIFY_ROOT/network-refusals.jsonl"
STATUS=0; STARTED=0; HOST_HOME=""

cleanup() {
  local code=$?
  trap - EXIT
  [[ $STATUS -ne 0 ]] && code=$STATUS
  if [[ -n "$RETAIN" ]]; then
    mkdir -p "$RETAIN"
    cp -R "$VERIFY_ROOT/artifacts/." "$RETAIN"/ 2>/dev/null || true
    cp "$VERIFY_ROOT/ledger.jsonl" "$VERIFY_ROOT/network-refusals.jsonl" "$RETAIN"/ 2>/dev/null || true
  fi
  if (( KEEP && STARTED && code != 130 )); then
    echo
    echo "Instance kept on http://127.0.0.1:$PORT (home $SANDBOX_HOME; its token is in gateway.json there)."
    echo "Tear it down with: $0 --teardown $VERIFY_ROOT"
    exit "$code"
  fi
  if (( STARTED )); then teardown_instance "$VERIFY_ROOT" || code=3; fi
  if [[ "$VERIFY_ROOT" == "$TMP_BASE"/jinn-fallback-chains.* && -d "$VERIFY_ROOT" ]]; then rm -r "$VERIFY_ROOT"; fi
  echo "Destroyed the instance and removed $VERIFY_ROOT"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

run_mode() {
  local mode="$1"
  HOST_HOME="$VERIFY_ROOT/host-$mode"
  SANDBOX_HOME="$HOST_HOME/.jinn-$INSTANCE"
  mkdir -p "$HOST_HOME/.config" "$HOST_HOME/.local/share" "$HOST_HOME/.cache" "$HOST_HOME/.local/state"
  for path in "$HOST_HOME" "$SANDBOX_HOME" "$HOST_HOME/profile-a" "$HOST_HOME/profile-b" "$SANDBOX_HOME/.claude-sandbox" "$VERIFY_ROOT/tmp"; do
    refuse_unless_temporary "path" "$path"
  done
  check_port "$PORT"
  printf 'PORT=%q\nHOST_HOME=%q\nSANDBOX_HOME=%q\nINSTANCE=%q\nNODE_BIN=%q\nNODE_DIR=%q\nVERIFY_ROOT=%q\nGATEWAY_REPO=%q\nHELPER=%q\nDRIVER_DIR=%q\n' \
    "$PORT" "$HOST_HOME" "$SANDBOX_HOME" "$INSTANCE" "$NODE_BIN" "$NODE_DIR" "$VERIFY_ROOT" "$GATEWAY_REPO" "$HELPER" "$DRIVER_DIR" > "$VERIFY_ROOT/instance.env"

  echo "== opencode mode: $mode (port $PORT)"
  # Set before create: a sandbox that is only partly made is still torn down (destroy checks its own marker).
  STARTED=1
  sandbox create "$INSTANCE" --port "$PORT" >/dev/null || return 1
  instance_env "$NODE_BIN" "$DRIVER_DIR/seed.mjs" --sandbox-home "$SANDBOX_HOME" --host-home "$HOST_HOME" \
    --gateway-repo "$GATEWAY_REPO" --harness-root "$REPO" --mode "$mode" > "$VERIFY_ROOT/layout-$mode.json" || return 1
  # The helper's health wait prints a curl error per poll while the gateway boots; only what else it says matters.
  sandbox start "$INSTANCE" >/dev/null 2>"$VERIFY_ROOT/start.err" || { grep -v "^curl: (7)" "$VERIFY_ROOT/start.err" >&2; return 1; }
  local driver_status=0
  instance_env "$NODE_BIN" "$DRIVER_DIR/scenarios.mjs" \
    --base-url "http://127.0.0.1:$PORT" --home "$SANDBOX_HOME" --layout "$VERIFY_ROOT/layout-$mode.json" \
    --scenario-file "$VERIFY_ROOT/scenario.json" --ledger "$VERIFY_ROOT/ledger.jsonl" --net-log "$VERIFY_ROOT/network-refusals.jsonl" \
    --results "$VERIFY_ROOT/artifacts/results-$mode.json" --pending "$PENDING" ${ONLY:+--only "$ONLY"} $( ((STRICT)) && echo --strict ) \
    || driver_status=$?
  mkdir -p "$VERIFY_ROOT/artifacts/gateway-logs-$mode"
  cp -R "$SANDBOX_HOME/logs/." "$VERIFY_ROOT/artifacts/gateway-logs-$mode"/ 2>/dev/null || true
  return "$driver_status"
}

modes=("$MODE"); [[ "$MODE" == both ]] && modes=(run server)
for index in "${!modes[@]}"; do
  run_mode "${modes[$index]}" || STATUS=1
  if (( index < ${#modes[@]} - 1 )) || (( ! KEEP )); then
    teardown_instance "$VERIFY_ROOT"; STARTED=0
    if (( index < ${#modes[@]} - 1 )); then rm -r "$HOST_HOME"; fi
  fi
done
exit "$STATUS"
