#!/bin/sh
# Docker HEALTHCHECK: is the gateway actually serving, or merely alive? A turn wedged on
# a consent dialog no PTY can answer keeps the process running, so nothing exit-based
# notices. /api/status is auth-exempt, so this needs no token.
#
# NOTE: `restart:` policies react to exits, not health — an unhealthy container is
# reported, not restarted.
set -eu

# A compose file or `docker run` written for an older build sets variables under the old prefix.
# Give each one the current name, unless the current name is set: the gateway does the same for itself.
for legacy_name in $(env | sed -n 's/^\(JINN_[A-Za-z0-9_]*\)=.*/\1/p'); do # rename:keep
  current_name="HUNDREDFOLD_${legacy_name#JINN_}" # rename:keep
  if [ -z "$(eval "printf %s \"\${$current_name+set}\"")" ]; then
    eval "$current_name=\${$legacy_name}"
    export "$current_name"
  fi
done

# Mirrors resolveHundredfoldHome() in shared/home.ts, absolutization included: a probe that
# disagrees about the home finds no gateway.json and reports a healthy container sick.
HUNDREDFOLD_HOME="${HUNDREDFOLD_HOME:-$HOME/.${HUNDREDFOLD_INSTANCE:-hundredfold}}"
case "$HUNDREDFOLD_HOME" in
  /*) ;;
  *) HUNDREDFOLD_HOME="$PWD/$HUNDREDFOLD_HOME" ;;
esac

# The URL the gateway recorded for itself at boot — writeGatewayInfo() derives it from
# the address it actually bound, so wildcard and IPv6 handling lives there rather than
# in a second implementation here. gateway.json is written with JSON.stringify(…, 2), so
# the key sits alone on its line; the fallback covers the window before it exists.
url=""
if [ -f "$HUNDREDFOLD_HOME/gateway.json" ]; then
  url=$(sed -n 's/^[[:space:]]*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HUNDREDFOLD_HOME/gateway.json" | head -n 1)
fi
[ -n "$url" ] || url="http://127.0.0.1:${HUNDREDFOLD_PORT:-7777}"

exec curl -fsS -m 5 -o /dev/null "$url/api/status"
