import { execFile } from "node:child_process";
import { logger } from "../shared/logger.js";
import { sshRun, shq } from "./remote-stage.js";
import { asRecord, numberOr, trimmedString } from "./opencode-protocol.js";

/**
 * What an OpenCode 2 `run` turn cost, read back from opencode once it has exited.
 *
 * `opencode run --format json` on 2.x ends a step that called a tool with a
 * `step_finish` event and a step that answers with none, so the stream carries
 * part of the turn's cost (a turn with no tool call, none of it). opencode records
 * the cost itself on every assistant message, and a server turn reads it from
 * there; this reads the same messages for a `run` turn with the CLI's own `api`
 * command, which starts a private server (`--standalone`: without it the call
 * leaves a background service behind) over the same data directory the turn used.
 *
 * Both the local and the remote transport end here: the first runs the binary,
 * the second runs it over ssh, and the sum is the same.
 */

/** Newest assistant messages asked for. A turn is a handful of steps; this is the ceiling on a very long one. */
const MESSAGE_PAGE = 200;
const READ_TIMEOUT_MS = 20_000;
/** A page of messages carries their content, tool output included. */
const READ_MAX_BUFFER = 64 * 1024 * 1024;

/** The CLI arguments that list a session's newest assistant messages, newest first. */
export function runCostArgs(engineSessionId: string): string[] {
  return [
    "api", "--standalone", "session.message.list",
    "--param", `sessionID=${engineSessionId}`,
    "--param", "order=desc",
    "--param", `limit=${MESSAGE_PAGE}`,
    "--param", "type=assistant",
  ];
}

/**
 * The summed cost of the assistant messages from `fromMessageId` (the turn's first)
 * to the newest, out of `api session.message.list` output (newest first).
 *
 * Undefined when the output is not a message list, or when the turn's first message
 * is not in it: nothing can be said about where the turn began, and a sum over
 * messages that may belong to earlier turns would charge this one for them.
 */
export function turnCostFromMessages(output: string, fromMessageId: string): number | undefined {
  let body: unknown;
  try {
    body = JSON.parse(output);
  } catch {
    return undefined;
  }
  const messages = asRecord(body)?.data;
  if (!Array.isArray(messages)) return undefined;
  let cost = 0;
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message || message.type !== "assistant") continue;
    cost += numberOr(message.cost, 0);
    if (trimmedString(message.id) === fromMessageId) return cost;
  }
  return undefined;
}

/** Run `bin args` locally and return its stdout, or undefined on any failure. */
export function runLocalCostRead(bin: string, args: string[], opts: { env: Record<string, string>; cwd: string }): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        bin,
        args,
        { env: opts.env, cwd: opts.cwd, timeout: READ_TIMEOUT_MS, maxBuffer: READ_MAX_BUFFER },
        (err, stdout) => resolve(err ? undefined : String(stdout)),
      );
      // `api` would otherwise wait on a terminal that is never there.
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

/** Run the remote host's opencode over ssh and return its stdout, or undefined on any failure. */
export async function runRemoteCostRead(destination: string, bin: string, args: string[]): Promise<string | undefined> {
  const result = await sshRun(destination, [[bin, ...args].map(shq).join(" ")], { timeoutMs: READ_TIMEOUT_MS });
  return result.code === 0 ? result.stdout : undefined;
}

/**
 * The turn's recorded cost, or undefined when it cannot be read. Never throws:
 * the answer is already in, and a turn must not fail because its bill could not be.
 */
export async function readRecordedTurnCost(
  read: (args: string[]) => Promise<string | undefined>,
  engineSessionId: string,
  fromMessageId: string,
): Promise<number | undefined> {
  try {
    const output = await read(runCostArgs(engineSessionId));
    const cost = output === undefined ? undefined : turnCostFromMessages(output, fromMessageId);
    if (cost === undefined) logger.warn(`opencode: could not read the cost of the turn in session ${engineSessionId}; recording what its events carried`);
    return cost;
  } catch (err) {
    logger.warn(`opencode: reading the cost of session ${engineSessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
