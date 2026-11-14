import path from "node:path";
import { logger } from "../shared/logger.js";
import { shq, sshRun, SSH_CONNECTION_FAILED } from "./remote-stage.js";

/**
 * The context meter's figure for a Claude session that runs on a remote host.
 *
 * A local session learns how full its window is from the live stream (the SSE
 * proxy's `message_start.usage`) and, at turn end, from its transcript on the
 * gateway's own disk. A remote session has neither: it runs without the proxy,
 * and its transcript is on the host the Stop hook named, not here. Without this
 * the figure stayed empty for the life of the session and the meter read "n/a".
 *
 * The newest assistant entry's usage is the size of the window as of the last
 * request, so the end of the transcript is all that is needed. It is read over
 * the same key-only ssh control channel the gateway already stages sessions
 * with, as a bounded `tail`.
 */

/** How much of the end of the transcript to read. One assistant line can be large; the usage is at its end. */
export const REMOTE_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const REMOTE_TAIL_TIMEOUT_MS = 20_000;

/** The context size one transcript line reports, or undefined when it is not an assistant entry with usage. */
function contextTokensOfLine(line: string): number | undefined {
  if (!line.includes('"usage"')) return undefined;
  let entry: { type?: unknown; message?: { usage?: Record<string, unknown> } };
  try { entry = JSON.parse(line); } catch { return undefined; }
  const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
  if (!usage) return undefined;
  const tokens = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/** The input-context size (input + cache-read + cache-creation tokens) of the newest assistant request in `text`, or undefined when it has none. A first line cut by the tail does not parse and is skipped. */
export function lastContextTokensInTranscriptText(text: string): number | undefined {
  let last: number | undefined;
  for (const line of text.split("\n")) last = contextTokensOfLine(line.trim()) ?? last;
  return last;
}

/** The remote command: print the end of one transcript. Only an absolute `.jsonl` path is read. */
export function remoteTranscriptTailCommand(transcriptPath: string): string | undefined {
  if (!path.posix.isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl") || /[\0\n\r]/.test(transcriptPath)) return undefined;
  return `tail -c ${REMOTE_TRANSCRIPT_TAIL_BYTES} -- ${shq(transcriptPath)}`;
}

/**
 * The context size a remote Claude session ended its turn with, read from its
 * transcript on `destination`. Undefined, never a throw, when the host cannot be
 * reached or the transcript has no usage: the meter then keeps its last figure.
 */
export async function readRemoteContextTokens(
  destination: string,
  transcriptPath: string,
  run: typeof sshRun = sshRun,
): Promise<number | undefined> {
  const command = remoteTranscriptTailCommand(transcriptPath);
  if (!command) return undefined;
  try {
    const res = await run(destination, [command], { timeoutMs: REMOTE_TAIL_TIMEOUT_MS });
    if (res.code === SSH_CONNECTION_FAILED || res.code === null || res.code !== 0) {
      logger.debug(`Remote context read from ${destination} failed (exit ${res.code}): ${res.stderr.trim().slice(0, 200)}`);
      return undefined;
    }
    return lastContextTokensInTranscriptText(res.stdout);
  } catch (err) {
    logger.debug(`Remote context read from ${destination} threw: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
