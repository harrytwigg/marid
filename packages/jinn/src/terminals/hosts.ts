import os from "node:os";
import path from "node:path";
import type { Employee, JinnConfig } from "../shared/types.js";
import { isRemoteTarget, sshDestination, validateDestination } from "../shared/remote-target.js";
import type { TerminalConfig, TerminalHostConfig } from "../shared/terminal-config.js";

/**
 * The machines an operator terminal can open on, read from the
 * instance's own configuration and nothing else: the gateway itself, every
 * distinct `remoteHost` the org's employees run on, and any `terminal.hosts`
 * the operator added. No host is named in code, so another install offers its
 * own machines rather than ours.
 */
export interface TerminalHost {
  /** Stored on the terminal session as its `sourceRef`, so a session keeps
   *  pointing at the same machine across restarts and config reloads. */
  id: string;
  label: string;
  kind: "local" | "ssh";
  /** Secondary line for the host menu: where it came from. */
  detail?: string;
  /** `user@host` or the bare host, for an ssh host. */
  destination?: string;
  /** Directory to start in; the login directory when unset. */
  cwd?: string;
}

export interface TerminalHostList {
  enabled: boolean;
  hosts: TerminalHost[];
  /** Configured hosts that were refused, phrased for the operator. */
  problems: string[];
  /** Why the feature is off, when it is. */
  disabledReason?: string;
}

type TerminalConfigSource = Pick<JinnConfig, "terminal" | "remote">;

export const LOCAL_TERMINAL_HOST_ID = "local";
const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The `terminal` block if it is a mapping; anything else reads as absent. */
function terminalBlock(config: Pick<JinnConfig, "terminal">): TerminalConfig {
  const block = config.terminal as unknown;
  return block && typeof block === "object" && !Array.isArray(block) ? block as TerminalConfig : {};
}

/**
 * On by default, on every install: the operator decided terminals are part of
 * the MVP and should work straight after an upgrade, with no config step.
 * `enabled: false` is the off switch. What keeps a default-on shell safe is the
 * rest of the design: operator-only routes and upgrade, the same-origin check on
 * the terminal socket, and a screen that never reaches disk.
 */
export function terminalsDisabledReason(config: TerminalConfigSource): string | undefined {
  return terminalBlock(config).enabled === false ? "Terminals are off (terminal.enabled: false)." : undefined;
}

export function terminalsEnabled(config: TerminalConfigSource): boolean {
  return terminalsDisabledReason(config) === undefined;
}

export function listTerminalHosts(config: TerminalConfigSource, employees: Iterable<Employee>): TerminalHostList {
  const disabledReason = terminalsDisabledReason(config);
  if (disabledReason) return { enabled: false, hosts: [], problems: [], disabledReason };
  const block = terminalBlock(config);
  const problems: string[] = [];
  const hosts: TerminalHost[] = [localHost(block)];
  const ids = new Set(hosts.map((h) => h.id));
  const destinations = new Set<string>();
  const add = (host: TerminalHost) => {
    ids.add(host.id);
    destinations.add(host.destination!);
    hosts.push(host);
  };

  const configured = block.hosts ?? [];
  if (!Array.isArray(configured)) problems.push("terminal.hosts must be a list of hosts; ignored");
  for (const entry of Array.isArray(configured) ? configured : []) {
    const host = configuredHost(entry, ids);
    if ("error" in host) problems.push(host.error);
    else add(host);
  }
  for (const host of derivedHosts(block, config, employees)) {
    if (!destinations.has(host.destination!) && !ids.has(host.id)) add(host);
  }
  return { enabled: true, hosts, problems };
}

function derivedHosts(block: TerminalConfig, config: Pick<JinnConfig, "remote">, employees: Iterable<Employee>): TerminalHost[] {
  return block.employeeHosts === false ? [] : employeeHosts(config, employees);
}

function localHost(block: TerminalConfig): TerminalHost {
  return {
    id: LOCAL_TERMINAL_HOST_ID,
    label: text(block.localLabel) || os.hostname(),
    kind: "local",
    detail: "This gateway",
  };
}

export function findTerminalHost(list: TerminalHostList, id: string | undefined): TerminalHost | undefined {
  return id ? list.hosts.find((host) => host.id === id) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface HostEntry { id: string; host: string; user: string; cwd: string; label: string }

function readHostEntry(entry: TerminalHostConfig): HostEntry {
  const raw = (entry ?? {}) as Partial<Record<keyof TerminalHostConfig, unknown>>;
  return { id: text(raw.id), host: text(raw.host), user: text(raw.user), cwd: text(raw.cwd), label: text(raw.label) };
}

function hostEntryProblem(entry: HostEntry, ids: Set<string>): string | undefined {
  if (!HOST_ID_RE.test(entry.id)) return `id must be letters, digits, ".", "_" or "-"`;
  if (ids.has(entry.id)) return "id is already taken";
  if (!entry.host) return "host is required";
  // The same charset guard remote employees get: the destination sits in ssh's
  // own argv, so a host of `-oProxyCommand=…` would run a command on the gateway.
  const bad = validateDestination(entry.host, entry.user);
  if (bad) return bad.error;
  if (entry.cwd && (entry.cwd.startsWith("~") || !path.posix.isAbsolute(entry.cwd))) {
    return `cwd "${entry.cwd}" must be an absolute path on that host`;
  }
  return undefined;
}

function configuredHost(raw: TerminalHostConfig, ids: Set<string>): TerminalHost | { error: string } {
  const entry = readHostEntry(raw);
  const problem = hostEntryProblem(entry, ids);
  if (problem) return { error: `terminal.hosts "${entry.id || entry.host || "(unnamed)"}": ${problem}` };
  const destination = sshDestination({ remoteHost: entry.host, ...(entry.user ? { remoteUser: entry.user } : {}) });
  return {
    id: entry.id,
    label: entry.label || entry.host,
    kind: "ssh",
    detail: destination,
    destination,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
  };
}

/** One host per distinct ssh destination the org's employees already use. The
 *  org loader has validated each target against the `remote` block, so these
 *  are hosts the gateway can already reach. */
function employeeHosts(config: Pick<JinnConfig, "remote">, employees: Iterable<Employee>): TerminalHost[] {
  const byDestination = new Map<string, { host: string; names: string[] }>();
  for (const employee of employees) {
    if (!isRemoteTarget(employee)) continue;
    const user = typeof employee.remoteUser === "string" ? employee.remoteUser.trim() : "";
    if (validateDestination(employee.remoteHost.trim(), user)) continue;
    const destination = sshDestination(employee);
    const entry = byDestination.get(destination) ?? { host: employee.remoteHost.trim(), names: [] };
    entry.names.push(employee.displayName || employee.name);
    byDestination.set(destination, entry);
  }
  const root = config.remote?.root;
  const cwd = root && path.posix.isAbsolute(root) ? root : undefined;
  return [...byDestination.entries()].map(([destination, entry]) => ({
    // The destination itself: unique by construction, and a configured id can
    // never collide with it because HOST_ID_RE admits neither ":" nor "@".
    id: `ssh:${destination}`,
    label: destination,
    kind: "ssh" as const,
    detail: employeeDetail(entry.names),
    destination,
    ...(cwd ? { cwd } : {}),
  }));
}

function employeeDetail(names: string[]): string {
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `Runs ${shown} +${names.length - 2}` : `Runs ${shown}`;
}
