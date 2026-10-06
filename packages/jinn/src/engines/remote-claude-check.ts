import { claudeMdExcludesProblem } from "../shared/claude-md-excludes.js";
import { shq, sshRun, type RemoteFacts } from "./remote-stage.js";

const claudeChecked = new Set<string>();

/**
 * Refuse a scoped spawn on a host whose Claude Code cannot be told to skip the
 * instructions above its stage directory (`claudeMdExcludes`). Asked once per host and
 * binary through `--version`, outside the per-host lock; only a pass is remembered, so a
 * host that upgrades is let in on its next spawn.
 */
export async function assertRemoteClaudeSkipsAncestors(destination: string, facts: Pick<RemoteFacts, "claudeBin">): Promise<void> {
  const bin = facts.claudeBin;
  const key = `${destination}\0${bin ?? ""}`;
  if (claudeChecked.has(key)) return;
  const res = bin ? await sshRun(destination, [`${shq(bin)} --version`]) : undefined;
  const problem = claudeMdExcludesProblem(`${bin ?? "(none found)"} on ${destination}`, res?.code === 0 ? res.stdout : "");
  if (problem) throw new Error(`Refusing to spawn a department-scoped remote session: ${problem}`);
  claudeChecked.add(key);
}

export function clearRemoteClaudeCheckCache(): void {
  claudeChecked.clear();
}
