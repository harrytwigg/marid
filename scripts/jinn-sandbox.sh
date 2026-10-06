#!/usr/bin/env bash
# Throwaway Marid gateway for visual verification.
#
#   jinn-sandbox.sh create  <instance> --port <p> [--build] [--seed]
#   jinn-sandbox.sh start   <instance>
#   jinn-sandbox.sh stop    <instance>
#   jinn-sandbox.sh destroy <instance> --yes
#
# Inputs, from the environment:
#   HOME       the sandbox host home. The instance lives at "$HOME/.jinn-<instance>" and
#              nothing is written anywhere else. The operator's real home is refused.
#   JINN_REPO  the checkout whose build the sandbox runs (default: the checkout this script is in).
#
# What it guarantees:
#   - the port is an integer at or above 8060 and never 7777 or 7788, checked at create and again
#     at start and stop against the port the sandbox's config.yaml actually declares;
#   - the operator's instance home (~/.jinn) and its gateway are never read, signalled or removed;
#   - every JINN_* variable that names an instance, a port or a gateway session is dropped before
#     anything runs, so a caller inside a live Jinn session cannot aim this at its own gateway;
#   - destroy only removes a directory this script created (it carries a marker file).
#
# Writing a verify script for a new phase (copy scripts/verify-chat-grid-drop.sh):
#   1. unset the caller's JINN_* identity first, then refuse ports below 8060, 7777 and 7788;
#   2. HELPER="${JINN_SANDBOX_HELPER:-$REPO/scripts/jinn-sandbox.sh}";
#   3. mkdir a throwaway HOST_HOME; the sandbox home is "$HOST_HOME/.jinn-<instance>";
#   4. env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" create <instance> --port "$PORT" --build --seed;
#   5. seed the phase's own data into "$SANDBOX_HOME" (sessions/registry.db, org/, config.yaml) before start;
#   6. env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" start <instance>;
#   7. run the browser journey against http://127.0.0.1:$PORT; the auth token is "$SANDBOX_HOME/gateway.json";
#   8. in an EXIT trap: stop, check the port is free, destroy <instance> --yes, then rm -rf "$HOST_HOME".
#
# --seed leaves three idle web sessions titled "#1 - Chat layout QA", "#2 - Delegation flow" and
# "#3 - Design pass" (source_ref sandbox:1..3). Exit codes: 0 ok, 1 an operation failed,
# 2 bad usage or a refused request.
set -euo pipefail

MIN_PORT=8060
HEALTH_TIMEOUT_S="${JINN_SANDBOX_HEALTH_TIMEOUT:-90}"
MARKER=".jinn-sandbox.json"

die() { echo "jinn-sandbox: $*" >&2; exit "${2:-2}"; }

# Same scrub the verify scripts do, repeated here because this script is also run by hand.
unset JINN_HOME JINN_PORT JINN_HOST JINN_INSTANCE JINN_GATEWAY_URL JINN_GATEWAY_TOKEN JINN_SESSION_ID \
  JINN_SESSION_CAPABILITY JINN_TAKE_PORT JINN_BINDING_HOME JINN_HOME_IDENTITY CLAUDE_CONFIG_DIR

SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${JINN_REPO:-$SCRIPT_REPO}"
[[ -f "$REPO/packages/jinn/package.json" ]] || die "JINN_REPO is not a Marid checkout: $REPO"
REPO="$(cd "$REPO" && pwd -P)"
JINN_BIN="$REPO/packages/jinn/dist/bin/jinn.js"

NODE_BIN="${JINN_SANDBOX_NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node is required"
PNPM_BIN="$(command -v pnpm || true)"

[[ -n "${HOME:-}" && -d "$HOME" ]] || die "HOME must name the sandbox host home"
HOST_HOME="$(cd "$HOME" && pwd -P)"
# The operator's real home comes from the account database, not from $HOME, which is exactly
# what a caller overrides.
ACCOUNT_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
[[ -n "$ACCOUNT_HOME" ]] || ACCOUNT_HOME="$(eval echo "~$(id -un)")"
ACCOUNT_HOME="$(cd "$ACCOUNT_HOME" 2>/dev/null && pwd -P || echo "$ACCOUNT_HOME")"
[[ "$HOST_HOME" != "$ACCOUNT_HOME" ]] || die "refusing to run with HOME set to the operator's real home ($HOST_HOME); pass a throwaway HOME"

[[ $# -ge 2 ]] || die "usage: jinn-sandbox.sh <create|start|stop|destroy> <instance> [flags]"
COMMAND="$1"; INSTANCE="$2"; shift 2
[[ "$INSTANCE" =~ ^[a-z][a-z0-9-]{0,47}$ && "$INSTANCE" != "jinn" ]] \
  || die "instance must be lowercase letters, digits and dashes, start with a letter, and not be 'jinn': $INSTANCE"

SANDBOX_HOME="$HOST_HOME/.jinn-$INSTANCE"
[[ "$SANDBOX_HOME" != "$ACCOUNT_HOME/.jinn" ]] || die "refusing the operator's instance home"

check_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || die "port must be an integer: $port"
  [[ "$port" != "7777" && "$port" != "7788" ]] || die "refusing port $port: it belongs to a live gateway" # footgun: ok this refusal set is the point of the check
  (( port >= MIN_PORT && port <= 65535 )) || die "port must be between $MIN_PORT and 65535: $port"
}

port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

# Everything the Marid CLI runs sees the sandbox and nothing else. JINN_PORT is deliberately not
# set: the sandbox's own config.yaml binds the gateway, and the verify scripts assert that.
sandbox_env() {
  env HOME="$HOST_HOME" JINN_HOME="$SANDBOX_HOME" JINN_REPO="$REPO" JINN_NO_OPEN=1 "$@"
}

jinn() { sandbox_env "$NODE_BIN" "$JINN_BIN" "$@"; }

require_sandbox() {
  [[ -d "$SANDBOX_HOME" && -f "$SANDBOX_HOME/$MARKER" ]] \
    || die "no sandbox named '$INSTANCE' under $HOST_HOME (missing $MARKER)"
  [[ -f "$JINN_BIN" ]] || die "build missing: $JINN_BIN (run create with --build)"
}

# The port the sandbox will actually bind: what config.yaml declares, re-validated on every
# operation so an edited config cannot point stop or start at a live gateway.
declared_port() {
  SANDBOX_CONFIG="$SANDBOX_HOME/config.yaml" "$NODE_BIN" -e '
const fs = require("node:fs")
let inGateway = false
for (const line of fs.readFileSync(process.env.SANDBOX_CONFIG, "utf8").split(/\r?\n/)) {
  if (/^gateway:\s*$/.test(line)) { inGateway = true; continue }
  if (inGateway && /^\S/.test(line)) break
  const match = inGateway ? line.match(/^\s+port:\s*(\d+)\s*$/) : null
  if (match) { process.stdout.write(match[1]); process.exit(0) }
}
process.exit(1)'
}

sandbox_port() {
  local port
  port="$(declared_port)" || die "cannot read gateway.port from $SANDBOX_HOME/config.yaml" 1
  check_port "$port"
  echo "$port"
}

wait_healthy() {
  local port="$1" waited=0
  while (( waited < HEALTH_TIMEOUT_S )); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/status"; then return 0; fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

patch_config() {
  # Written through the same document patcher the product uses, so the sandbox config.yaml keeps
  # the shape `jinn setup` gave it. authRequired stays off: the browser journeys send the token
  # from gateway.json as a bearer header.
  SANDBOX_HOME="$SANDBOX_HOME" PORT="$1" REPO="$REPO" "$NODE_BIN" --input-type=module - <<'JS'
import path from "node:path"
import { pathToFileURL } from "node:url"
const dist = path.join(process.env.REPO, "packages/jinn/dist/src")
const { patchConfigFile } = await import(pathToFileURL(path.join(dist, "shared/config-document.js")).href)
const { ensureGatewayAuthToken } = await import(pathToFileURL(path.join(dist, "gateway/auth.js")).href)
patchConfigFile(path.join(process.env.SANDBOX_HOME, "config.yaml"), [
  { path: ["gateway", "port"], value: Number(process.env.PORT) },
  { path: ["gateway", "authRequired"], value: false },
  { path: ["portal", "companyName"], value: "Sandbox" },
  { path: ["portal", "onboarded"], value: true },
])
ensureGatewayAuthToken(process.env.SANDBOX_HOME)
JS
}

seed_sessions() {
  SANDBOX_HOME="$SANDBOX_HOME" REPO="$REPO" "$NODE_BIN" --input-type=module - <<'JS'
import crypto from "node:crypto"
import path from "node:path"
import { createRequire } from "node:module"
const requireFromJinn = createRequire(path.join(process.env.REPO, "packages/jinn/package.json"))
const Database = requireFromJinn("better-sqlite3")
const db = new Database(path.join(process.env.SANDBOX_HOME, "sessions", "registry.db"))
const now = new Date().toISOString()
const rows = [
  ["sandbox:1", "#1 - Chat layout QA"],
  ["sandbox:2", "#2 - Delegation flow"],
  ["sandbox:3", "#3 - Design pass"],
]
const insert = db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id, engine, source, source_ref, connector, session_key, model, title,
    prompt_excerpt, status, total_cost, total_turns, last_context_tokens,
    created_at, last_activity
  ) VALUES (?, 'claude', 'web', ?, 'web', ?, 'opus', ?, ?, 'idle', 0, 0, 900, ?, ?)
`)
for (const [sourceRef, title] of rows) {
  insert.run(crypto.randomUUID(), sourceRef, `web:${sourceRef}`, title, title, now, now)
}
db.close()
JS
}

cmd_create() {
  local port="" build=0 seed=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) [[ $# -ge 2 ]] || die "--port needs a value"; port="$2"; shift 2 ;;
      --build) build=1; shift ;;
      --seed) seed=1; shift ;;
      *) die "unknown flag for create: $1" ;;
    esac
  done
  [[ -n "$port" ]] || die "create needs --port <port>"
  check_port "$port"
  [[ ! -e "$SANDBOX_HOME" ]] || die "sandbox directory already exists: $SANDBOX_HOME"
  if port_listening "$port"; then die "port $port is already in use"; fi

  if (( build )) || [[ ! -f "$JINN_BIN" ]]; then
    (( build )) || die "no build at $JINN_BIN; pass --build"
    [[ -n "$PNPM_BIN" ]] || die "pnpm is required for --build"
    echo "Building $REPO"
    # Built with the operator's real HOME untouched: the build never reads the instance home, and
    # pnpm's store and caches are the tool's own.
    ( cd "$REPO" && env -u JINN_HOME "$PNPM_BIN" build ) || die "build failed" 1
  fi
  [[ -f "$JINN_BIN" ]] || die "build missing after build step: $JINN_BIN" 1

  mkdir -p "$SANDBOX_HOME"
  # From here on a failure removes what this call made, and only that.
  CREATE_OK=0
  trap 'if [[ "$CREATE_OK" -ne 1 && -d "$SANDBOX_HOME" ]]; then rm -rf "$SANDBOX_HOME"; fi' EXIT
  printf '{"instance":"%s","port":%s,"repo":"%s","createdAt":"%s"}\n' \
    "$INSTANCE" "$port" "$REPO" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SANDBOX_HOME/$MARKER"

  echo "Setting up $SANDBOX_HOME"
  JINN_SETUP_NAME="Sandbox" jinn setup </dev/null >"$SANDBOX_HOME/setup.log" 2>&1 \
    || { cat "$SANDBOX_HOME/setup.log" >&2; die "jinn setup failed" 1; }
  [[ -f "$SANDBOX_HOME/config.yaml" ]] || die "setup did not create config.yaml" 1
  patch_config "$port" || die "could not patch config.yaml" 1
  (( seed )) && { [[ -f "$SANDBOX_HOME/sessions/registry.db" ]] || die "setup left no sessions/registry.db to seed" 1; seed_sessions; }
  CREATE_OK=1
  echo "Created sandbox '$INSTANCE' at $SANDBOX_HOME on port $port"
}

cmd_start() {
  [[ $# -eq 0 ]] || die "start takes no flags"
  require_sandbox
  local port; port="$(sandbox_port)"
  if port_listening "$port"; then die "port $port is already in use" 1; fi
  jinn start --daemon </dev/null >"$SANDBOX_HOME/start.log" 2>&1 \
    || { cat "$SANDBOX_HOME/start.log" >&2; die "jinn start failed" 1; }
  wait_healthy "$port" || die "gateway did not become healthy on port $port within ${HEALTH_TIMEOUT_S}s (see $SANDBOX_HOME/logs)" 1
  echo "Sandbox '$INSTANCE' listening on http://127.0.0.1:$port"
}

cmd_stop() {
  [[ $# -eq 0 ]] || die "stop takes no flags"
  require_sandbox
  local port; port="$(sandbox_port)"
  jinn stop </dev/null || die "jinn stop failed" 1
  local waited=0
  while port_listening "$port" && (( waited < 40 )); do sleep 0.25; waited=$((waited + 1)); done
  if port_listening "$port"; then die "listener remains on port $port after stop" 1; fi
  echo "Sandbox '$INSTANCE' stopped"
}

cmd_destroy() {
  local yes=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) yes=1; shift ;;
      *) die "unknown flag for destroy: $1" ;;
    esac
  done
  (( yes )) || die "destroy removes $SANDBOX_HOME; pass --yes"
  [[ -d "$SANDBOX_HOME" ]] || { echo "Sandbox '$INSTANCE' does not exist"; return 0; }
  [[ -f "$SANDBOX_HOME/$MARKER" ]] || die "refusing to remove $SANDBOX_HOME: it was not created by this script"
  # Stop first so no daemon is left holding a deleted home; an already-stopped sandbox is fine.
  if [[ -f "$JINN_BIN" ]] && port="$(declared_port 2>/dev/null)"; then
    check_port "$port"
    jinn stop </dev/null >/dev/null 2>&1 || true
    if port_listening "$port"; then die "listener remains on port $port; not removing a live sandbox" 1; fi
  fi
  [[ "$SANDBOX_HOME" == "$HOST_HOME"/.jinn-* ]] || die "refusing to remove a path outside the sandbox home: $SANDBOX_HOME"
  rm -rf "$SANDBOX_HOME"
  echo "Destroyed sandbox '$INSTANCE'"
}

case "$COMMAND" in
  create) cmd_create "$@" ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  destroy) cmd_destroy "$@" ;;
  *) die "unknown command: $COMMAND (create|start|stop|destroy)" ;;
esac
