/**
 * The remote half of finding an opencode internal fallback (see
 * opencode-internal-fallback.ts): a shell snippet the host-facts script runs
 * on a remote host, and the parse of what it printed.
 *
 * Best effort and read-only. It looks where the local detection looks, minus
 * what needs a JSON parser: a `grep` for the plugin's name in the operator's
 * opencode config files (a comment that merely mentions it is a false
 * positive), the plugin files, and a `rate-limit-fallback.json` that does not
 * say `"enabled": false`. A project directory is not read: the host does not
 * know which project a session will run in.
 */

/** Appended to the facts script's opencode branch. Prints `opencodefallback.<n>=<path>` per finding. */
export const FALLBACK_FACTS_SNIPPET = `
  xdg=\${XDG_CONFIG_HOME:-$HOME/.config}
  n=0
  ocfb() { n=$((n+1)); printf 'opencodefallback.%s=%s\\n' "$n" "$1"; }
  for d in "$xdg/opencode" "$HOME/.opencode"; do
    for f in "$d/opencode.json" "$d/opencode.jsonc" "$d/config.json"; do
      if [ -f "$f" ] && grep -q -E '"(opencode-rate-limit|[^"]*model-fallback)' "$f" 2>/dev/null; then ocfb "$f"; fi
    done
    for f in "$d"/plugin/model-fallback.* "$d"/plugin/opencode-rate-limit.* "$d"/plugins/model-fallback "$d"/plugins/opencode-rate-limit; do
      if [ -e "$f" ]; then ocfb "$f"; fi
    done
  done
  for d in "$HOME/.opencode" "$HOME/opencode" "$HOME" "$xdg/.opencode" "$xdg/opencode" "$xdg"; do
    f="$d/rate-limit-fallback.json"
    if [ -f "$f" ] && ! grep -q -E '"enabled"[[:space:]]*:[[:space:]]*false' "$f" 2>/dev/null; then ocfb "$f"; fi
  done`;

/** The paths the snippet printed, from the facts script's key=value lines, in order, once each. */
export function remoteFallbackSources(kv: Record<string, string>): string[] {
  const found = Object.entries(kv)
    .filter(([key]) => key.startsWith("opencodefallback."))
    .sort(([a], [b]) => Number(a.slice(a.indexOf(".") + 1)) - Number(b.slice(b.indexOf(".") + 1)))
    .map(([, value]) => value)
    .filter(Boolean);
  return [...new Set(found)];
}
