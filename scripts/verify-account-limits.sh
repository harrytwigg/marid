#!/usr/bin/env bash
set -euo pipefail

# The caller's shell usually carries its own live instance: a Jinn session exports
# JINN_HOME, JINN_PORT, JINN_HOST, JINN_INSTANCE and the gateway URL/token/session id.
# Those are not inert here. resolveJinnHome() (packages/jinn/src/shared/home.ts) returns
# $JINN_HOME outright and otherwise names the directory after $JINN_INSTANCE, so setting
# HOME below is not enough on its own; applyGatewayEnvOverrides()
# (packages/jinn/src/shared/config.ts) then replaces whatever port the sandbox's own
# config.yaml declares with $JINN_PORT. Inherited, they aim this script's
# create/start/stop/destroy cycle at the operator's gateway on 7777 instead of the
# throwaway sandbox. Scrub them before anything reads them. The script's own inputs --
# JINN_VERIFY_* and JINN_SANDBOX_HELPER -- are deliberately kept, and JINN_REPO is
# exported per-command below rather than inherited.
unset JINN_HOME JINN_PORT JINN_HOST JINN_INSTANCE JINN_GATEWAY_URL JINN_GATEWAY_TOKEN JINN_SESSION_ID

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR_HOME="$HOME"
HELPER="${JINN_SANDBOX_HELPER:-$REPO/scripts/jinn-sandbox.sh}"
PORT="${JINN_VERIFY_PORT:-8061}"
TMP_BASE="${JINN_VERIFY_TMP_ROOT:-/tmp}"
INSTANCE="account-limits-verification"

PNPM_BIN="$(command -v pnpm || true)"
if [[ -z "$PNPM_BIN" ]]; then echo "pnpm is required" >&2; exit 2; fi
NODE_BIN="${JINN_VERIFY_NODE_BIN:-$(dirname "$PNPM_BIN")/node}"
if [[ ! -x "$NODE_BIN" ]]; then echo "Node beside pnpm not found: $NODE_BIN" >&2; exit 2; fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 8060 )) || [[ "$PORT" == "7777" || "$PORT" == "7788" ]]; then
  echo "JINN_VERIFY_PORT must be an integer at or above 8060 and cannot be 7777 or 7788" >&2
  exit 2
fi
if [[ ! -x "$HELPER" ]]; then echo "Sandbox helper not found: $HELPER" >&2; exit 2; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Candidate port $PORT is already in use" >&2
  exit 2
fi

VERIFY_ROOT="$(mktemp -d "$TMP_BASE/jinn-account-limits.XXXXXX")"
HOST_HOME="$VERIFY_ROOT/host"
SANDBOX_HOME="$HOST_HOME/.jinn-$INSTANCE"
ARTIFACTS="$SANDBOX_HOME/sandbox-artifacts/account-limits"
RETAIN_DIR="${JINN_VERIFY_RETAIN_DIR:-}"
BASE_URL="http://127.0.0.1:$PORT"
STARTED=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$RETAIN_DIR" && -d "$ARTIFACTS" ]]; then
    mkdir -p "$RETAIN_DIR"
    cp -R "$ARTIFACTS"/. "$RETAIN_DIR"/
  fi
  if [[ "$STARTED" -eq 1 ]]; then
    env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" stop "$INSTANCE" >/dev/null 2>&1 || status=3
    for _ in {1..20}; do
      if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
      sleep 0.25
    done
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "Sandbox listener remains on port $PORT" >&2
      status=3
    fi
    env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" destroy "$INSTANCE" --yes >/dev/null 2>&1 || status=3
  fi
  if [[ "$VERIFY_ROOT" == "$TMP_BASE"/jinn-account-limits.* && -d "$VERIFY_ROOT" ]]; then
    rm -rf "$VERIFY_ROOT"
  else
    echo "Refusing cleanup outside the current verification root: $VERIFY_ROOT" >&2
    status=3
  fi
  echo "Destroyed the account limits sandbox and removed $VERIFY_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$HOST_HOME"
env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" create "$INSTANCE" --port "$PORT" --build
"$NODE_BIN" "$REPO/scripts/seed-account-limits.mjs" "$SANDBOX_HOME" "$HOST_HOME"
# The sandbox must be bound by its own config.yaml, checked before the daemon reads it. This
# is the other half of the scrub at the top: if an inherited JINN_PORT ever slips past it,
# applyGatewayEnvOverrides() would silently rebind the gateway away from $PORT and the run
# would be aimed somewhere nobody chose.
CONFIGURED_PORT="$(SANDBOX_CONFIG="$SANDBOX_HOME/config.yaml" "$NODE_BIN" -e '
const fs = require("node:fs")
let inGateway = false
for (const line of fs.readFileSync(process.env.SANDBOX_CONFIG, "utf8").split(/\r?\n/)) {
  if (/^gateway:\s*$/.test(line)) { inGateway = true; continue }
  if (inGateway && /^\S/.test(line)) break
  const match = inGateway ? line.match(/^\s+port:\s*(\d+)\s*$/) : null
  if (match) { process.stdout.write(match[1]); process.exit(0) }
}
process.exit(1)')"
if [[ "$CONFIGURED_PORT" != "$PORT" ]]; then
  echo "Sandbox config.yaml declares gateway port ${CONFIGURED_PORT:-<none>}, expected $PORT" >&2
  exit 2
fi
echo "Sandbox config.yaml declares gateway port $CONFIGURED_PORT before start"

STARTED=1
env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" start "$INSTANCE"

export JINN_VERIFY_HOME="$SANDBOX_HOME"
export JINN_VERIFY_BASE_URL="$BASE_URL"
export JINN_VERIFY_ARTIFACTS="$ARTIFACTS"
mkdir -p "$ARTIFACTS"

cd "$REPO"
pnpm exec playwright test --config playwright.account-limits.config.ts "$@"
