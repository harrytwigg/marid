import type * as pty from "node-pty";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import type { FreebuffEngineConfig } from "../shared/freebuff-config.js";
import type { PtyExit, PtyHandle } from "./pty-lifecycle.js";
import type { FreebuffTerminal } from "./freebuff-terminal.js";
import type { FreebuffChatRef, FreebuffChatSource } from "./freebuff-chat.js";
import type { FreebuffPlace } from "./freebuff-failure.js";
import type { FreebuffTarget, SpawnParams, SpawnPty } from "./freebuff-spawn.js";

/** Why a turn stopped other than by finishing. */
export type Stop =
  | { kind: "interrupt"; reason: string }
  | { kind: "exit"; exit: PtyExit | undefined; output: string };

export class TurnStopped extends Error {
  constructor(readonly stop: Stop) {
    super(stop.kind === "interrupt" ? stop.reason : "freebuff exited");
    this.name = "TurnStopped";
  }
}

export interface ActiveTurn {
  abort: AbortController;
}

export interface Live {
  proc: pty.IPty;
  handle: PtyHandle;
  terminal: FreebuffTerminal;
  place: FreebuffPlace;
  params: SpawnParams;
  /** The chat this process is in: known up front for `--continue`, found after the first turn otherwise. */
  chat?: FreebuffChatRef;
  /** Every chat that existed before this process started, so a new one can be told apart. */
  before: Set<string>;
  chats: FreebuffChatSource;
  /** Raw output kept until the TUI first shows itself, for a failed start. */
  startOutput: { text: string };
  booted: boolean;
  exited?: PtyExit;
}

export interface FreebuffEngineDeps {
  /** The `remote` block, read live so an edit takes effect on the next spawn. */
  remote?: () => RemoteExecutionConfig | undefined;
  /** `engines.freebuff`, read live. */
  config?: () => FreebuffEngineConfig | undefined;
  /** Test seams. */
  spawnPty?: SpawnPty;
  localChats?: () => FreebuffChatSource;
}

const hostOf = (target: FreebuffTarget | undefined): string => (target ? `${target.remoteUser ?? ""}@${target.remoteHost}` : "");
const dirOf = (target: FreebuffTarget | undefined, cwd: string): string | undefined => (target ? target.remoteCwd : cwd);
const chatIdOf = (chatId: string | undefined): string => chatId ?? "";

/** Whether a process is still the one a turn wants: same host, same folder, same chat. */
export function reusableProcess(
  live: Pick<Live, "params" | "chat" | "exited">,
  want: { target?: FreebuffTarget; cwd: string; chatId?: string },
): boolean {
  if (live.exited) return false;
  if (hostOf(live.params.target) !== hostOf(want.target)) return false;
  if (dirOf(live.params.target, live.params.cwd) !== dirOf(want.target, want.cwd)) return false;
  return chatIdOf(want.chatId) === chatIdOf(live.chat?.chatId);
}
