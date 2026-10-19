import path from "node:path";
import type { FallbackFinding } from "./opencode-internal-fallback.js";

/**
 * The lines `jinn doctor` prints so the operator can remove an opencode
 * internal fallback by hand, one host at a time, naming the files it found.
 * The gateway never edits the operator's files. These paths appear only in
 * doctor's output on the operator's own machine.
 */

const PLUGIN_DIR_NAMES = new Set(["plugin", "plugins"]);
const CONFIG_NAMES = new Set(["opencode.json", "opencode.jsonc", "config.json"]);

/** A remote host reports only paths: what each is follows from its name. */
export function classifyFallbackPath(file: string): FallbackFinding {
  const name = path.posix.basename(file);
  const parent = path.posix.basename(path.posix.dirname(file));
  const grand = path.posix.basename(path.posix.dirname(path.posix.dirname(file)));
  if (name === "rate-limit-fallback.json") return { kind: "settings", file };
  if (CONFIG_NAMES.has(name)) return { kind: "config-plugin", file, key: "plugin", entry: "opencode-rate-limit" };
  if (PLUGIN_DIR_NAMES.has(parent) || PLUGIN_DIR_NAMES.has(grand)) return { kind: "plugin-file", path: file };
  return { kind: "settings", file };
}

/** The one-line fix for one finding. */
export function fixLine(finding: FallbackFinding, remote = false): string {
  if (finding.kind === "settings") return `delete ${finding.file}, or set "enabled": false in it`;
  if (finding.kind === "plugin-file") return `delete ${finding.path}`;
  const entry = remote ? "the `opencode-rate-limit` (or model-fallback) entry" : `\`${finding.entry}\``;
  return `remove ${entry} from \`${finding.key}\` in ${finding.file}`;
}

/** What one host needs done, in order: its fix lines. `host` is absent for the gateway's own host. */
export interface HostFix {
  host?: string;
  findings: FallbackFinding[];
}

/**
 * The whole procedure. The migration comes first because it reads the host's
 * `rate-limit-fallback.json`: once that is deleted or disabled there is nothing
 * left to migrate.
 */
export function internalFallbackFixLines(hosts: HostFix[]): string[] {
  const lines: string[] = [];
  const local = hosts.find((h) => h.host === undefined);
  const settings = hosts.flatMap((h) => h.findings.filter((f) => f.kind === "settings").map((f) => ({ host: h.host, file: (f as { file: string }).file })));
  if (settings.length) {
    lines.push("1. Turn the plugin's settings into a gateway chain first (the command reads rate-limit-fallback.json):");
    if (local?.findings.some((f) => f.kind === "settings")) lines.push("     jinn fallback migrate-opencode --write");
    for (const { host, file } of settings.filter((s) => s.host !== undefined)) {
      lines.push(`     copy ${file} from ${host} here, then: jinn fallback migrate-opencode --file <copy> --write`);
    }
  } else {
    lines.push("1. No rate-limit-fallback.json was found, so there are no settings to migrate; set a chain by hand if you want one (docs/fallback-chains.md).");
  }
  lines.push("2. Then remove the plugin by hand:");
  for (const { host, findings } of hosts) {
    lines.push(`   ${host === undefined ? "On this host:" : `On ${host}:`}`);
    for (const finding of findings) lines.push(`     - ${fixLine(finding, host !== undefined)}`);
  }
  lines.push("3. Run `jinn doctor` again: it should report no internal fallback.");
  return lines;
}
