import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as pty from "node-pty";
import type { RemoteTarget } from "../shared/types.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { assertRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { employeeSessionEnv } from "../sessions/employee-env.js";
import { buildSshSpawnArgs, ensureRemoteReady, remoteNodeDir, requireRemoteEngineBin } from "./remote-stage.js";
import { chatKey, type FreebuffChatSource } from "./freebuff-chat.js";
import { FreebuffFailure, notSignedInMessage } from "./freebuff-failure.js";
import { remoteSignedIn } from "./freebuff-remote.js";

export type FreebuffTarget = RemoteTarget & { remoteHost: string };

/** Where a Freebuff process runs and which chat it holds. */
export interface SpawnParams {
  cwd: string;
  bin?: string;
  /** `--continue` this chat. Unset starts a new one. */
  chatId?: string;
  /** The host to run on, for a remote employee. */
  target?: FreebuffTarget;
}

export interface Geometry {
  cols: number;
  rows: number;
}

export type SpawnPty = typeof pty.spawn;

/** The arguments the CLI is started with. `--trust-agents` skips the folder-trust prompt nobody is there to answer. */
export function buildFreebuffArgs(params: Pick<SpawnParams, "cwd" | "chatId">): string[] {
  return ["--cwd", params.cwd, "--trust-agents", ...(params.chatId ? ["--continue", params.chatId] : [])];
}

/**
 * Fails when Freebuff has no credentials where it will run. A CLI that is not
 * signed in is not refused at start: it shows its login page on the first message,
 * and nobody is there to finish it.
 */
export async function assertSignedIn(target: FreebuffTarget | undefined): Promise<void> {
  if (!target) {
    if (!fs.existsSync(path.join(os.homedir(), ".config", "manicode", "credentials.json"))) throw new FreebuffFailure(notSignedInMessage("local"));
    return;
  }
  // Unknown (ssh failed) is not "signed out": the screen will say if it really is.
  if (await remoteSignedIn(sshDestination(target)) === false) throw new FreebuffFailure(notSignedInMessage("remote"));
}

/** Every chat on disk now, so a chat born after the process starts can be told apart. */
export async function chatsBefore(chats: FreebuffChatSource, label: string): Promise<Set<string>> {
  const before = new Set<string>();
  try {
    for (const chat of await chats.list()) before.add(chatKey(chat));
  } catch (err) {
    logger.warn(`FreebuffInteractiveEngine: could not list existing chats before spawning ${label}: ${err instanceof Error ? err.message : err}`);
  }
  return before;
}

export function freebuffChildEnv(sessionId: string): Record<string, string> {
  const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
  env.TERM = "xterm-256color";
  env.JINN_SESSION_ID = sessionId;
  Object.assign(env, employeeSessionEnv(sessionId));
  return env;
}

export function spawnLocalFreebuff(
  spawnPty: SpawnPty,
  params: SpawnParams,
  configuredBin: string | undefined,
  geom: Geometry,
  env: Record<string, string>,
): pty.IPty {
  const bin = resolveBin("freebuff", params.bin || configuredBin);
  logger.info(`FreebuffInteractiveEngine spawning ${bin} (chat: ${params.chatId ?? "new"})`);
  return spawnPty(bin, buildFreebuffArgs(params), { name: "xterm-256color", ...geom, cwd: params.cwd, env });
}

export interface RemoteSpawn {
  spawnPty: SpawnPty;
  target: FreebuffTarget;
  remote: RemoteExecutionConfig | undefined;
  chatId: string | undefined;
  geom: Geometry;
  env: Record<string, string>;
}

/** `ssh -tt` to the host, running Freebuff in the employee's directory. Nothing of the gateway's is needed there. */
export async function spawnRemoteFreebuff({ spawnPty, target, remote, chatId, geom, env }: RemoteSpawn): Promise<pty.IPty> {
  assertRemoteTarget(target, remote);
  const readiness = await ensureRemoteReady(target, remote, { engine: "freebuff", allowWake: false });
  if (!readiness.ready) throw new FreebuffFailure(`remote host not ready: ${readiness.reason}`);
  const destination = sshDestination(target);
  const sshArgs = buildSshSpawnArgs({
    destination,
    tunnelPort: 0,
    gatewayPort: 0,
    reverseTunnel: false,
    remoteCwd: target.remoteCwd!,
    remoteEnv: { TERM: "xterm-256color" },
    // freebuff is a node program: put its node first, as the other remote engines do.
    pathPrepend: [remoteNodeDir(readiness.facts)],
    bin: requireRemoteEngineBin(destination, readiness.facts, "freebuff"),
    args: buildFreebuffArgs({ cwd: target.remoteCwd!, chatId }),
  });
  logger.info(`FreebuffInteractiveEngine spawning REMOTE session on ${destination}:${target.remoteCwd} (chat: ${chatId ?? "new"})`);
  // The local cwd of the ssh client is irrelevant: the session's is the `cd` in the remote command.
  return spawnPty(resolveBin("ssh"), sshArgs, { name: "xterm-256color", ...geom, cwd: JINN_HOME, env });
}
