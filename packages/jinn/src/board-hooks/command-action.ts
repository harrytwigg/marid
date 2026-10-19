import { spawn, type ChildProcess } from "node:child_process";
import type { BoardHookCommand } from "../shared/board-hooks-config.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { evaluateCommandPolicy } from "../shared/command-policy.js";
import { JINN_HOME } from "../shared/paths.js";
import { redactText } from "../shared/redact.js";
import type { ActionOutcome, HookPayload } from "./types.js";

/** How much of a command's combined stdout and stderr the run row keeps. */
const OUTPUT_TAIL_BYTES = 4096;
/** An environment variable that large can fail the spawn (E2BIG); the payload is always on stdin. */
const MAX_PAYLOAD_ENV_BYTES = 64 * 1024;

const liveCommands = new Set<ChildProcess>();

/** Stop every command still running (gateway shutdown, tests). */
export function stopHookCommands(): void {
  for (const child of liveCommands) endCommand(child);
}

/** SIGTERM the command's whole process group, so a shell's children go with it and release the output pipes. */
function endCommand(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export function hookCommandEnv(payload: HookPayload, json: string): Record<string, string> {
  return {
    ...buildEngineChildEnv(process.env),
    JINN_HOOK_NAME: payload.hook,
    JINN_HOOK_EVENT: payload.event,
    JINN_HOOK_FIRE_ID: payload.fireId,
    JINN_HOOK_TODO_ID: payload.todo.id,
    JINN_HOOK_FROM: payload.from ?? "",
    JINN_HOOK_TO: payload.to ?? "",
    JINN_HOOK_ACTOR: payload.actor.employee ?? payload.actor.kind,
    JINN_HOOK_CHAIN: payload.chain.join(","),
    ...(Buffer.byteLength(json) <= MAX_PAYLOAD_ENV_BYTES ? { JINN_HOOK_PAYLOAD: json } : {}),
  };
}

function tailOf(chunks: Buffer[]): string {
  return redactText(Buffer.concat(chunks).subarray(-OUTPUT_TAIL_BYTES).toString("utf8"));
}

function exitOutcome(code: number | null, signal: NodeJS.Signals | null, output: string): ActionOutcome {
  if (code === 0) return { status: "ok", exitCode: 0, output };
  const why = signal ? `killed by ${signal}` : `exited with code ${code}`;
  return { status: "error", exitCode: code, error: why, output };
}

function runChild(child: ChildProcess, json: string): Promise<ActionOutcome> {
  liveCommands.add(child);
  let tail: Buffer = Buffer.alloc(0);
  const collect = (chunk: Buffer) => { tail = Buffer.concat([tail, chunk]).subarray(-OUTPUT_TAIL_BYTES); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(json);
  return new Promise<ActionOutcome>((resolve) => {
    child.on("error", (error) => resolve({ status: "error", error: error.message, output: tailOf([tail]) }));
    child.on("close", (code, signal) => resolve(exitOutcome(code, signal, tailOf([tail]))));
  }).finally(() => liveCommands.delete(child));
}

/**
 * Run the hook's command with `/bin/sh -c`, the payload on stdin and in the
 * environment. There is no timeout: a command that hangs stays running until it
 * exits or the gateway stops. A command the gateway's command policy refuses is
 * an error run, and nothing is started.
 */
export async function runCommandAction(command: BoardHookCommand, payload: HookPayload): Promise<ActionOutcome> {
  const decision = evaluateCommandPolicy(command.run);
  if (decision.action === "block") return { status: "error", error: `refused by the command policy: ${decision.reason}` };
  const json = JSON.stringify(payload);
  const child = spawn("/bin/sh", ["-c", command.run], {
    cwd: command.cwd ?? JINN_HOME,
    env: hookCommandEnv(payload, json),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  return runChild(child, json);
}
