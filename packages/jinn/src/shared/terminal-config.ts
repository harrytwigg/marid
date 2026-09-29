/**
 * Operator terminals: a login shell on the gateway or on another
 * machine, opened from the web console and listed in the sidebar like a chat.
 *
 * Every field is optional. With no `terminal` block the feature is on and offers
 * the gateway itself plus every distinct `remoteHost` the org's employees already
 * run on, so an install needs no configuration to reach the machines it knows.
 */
export interface TerminalConfig {
  /** `false` turns terminals off. Default on, on every install. Terminals are
   *  operator-only and same-origin either way. */
  enabled?: boolean;
  /** Offer every distinct employee `remoteHost` as a terminal host. Default true. */
  employeeHosts?: boolean;
  /** Label for the gateway's own host. Default: the machine's hostname. */
  localLabel?: string;
  /** Shell binary for a local terminal. Default `$SHELL`, else `/bin/sh`. */
  shell?: string;
  /** Additional machines, reached with `ssh`. */
  hosts?: TerminalHostConfig[];
  /** Live shells allowed at once, across every host. Default 16. */
  maxLive?: number;
}

export interface TerminalHostConfig {
  /** Stable id, stored on each terminal session. Letters, digits, `.`, `_`, `-`. */
  id: string;
  /** What the sidebar and the host menu show. Default: the host. */
  label?: string;
  /** Hostname, address or `~/.ssh/config` alias. */
  host: string;
  /** ssh user. Default: ssh's own resolution. */
  user?: string;
  /** Absolute directory on that host to start in. Default: the user's home. */
  cwd?: string;
}
