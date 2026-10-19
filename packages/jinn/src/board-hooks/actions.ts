import { spawnSession } from "../gateway/spawn-session.js";
import type { ApiContext } from "../gateway/api.js";
import type { BoardHookNotify, BoardHookSpawn } from "../shared/board-hooks-config.js";
import { redactText } from "../shared/redact.js";
import { renderSpawnPrompt, renderTemplate } from "./template.js";
import type { ActionOutcome, HookPayload } from "./types.js";

export { runCommandAction } from "./command-action.js";

/** Start the hook's session: no parent (its callback must not wake the actor), hook provenance, the full payload in the prompt. */
export async function runSpawnAction(context: ApiContext, spawn: BoardHookSpawn, payload: HookPayload): Promise<ActionOutcome> {
  const outcome = await spawnSession(context, {
    prompt: renderSpawnPrompt(spawn.prompt, payload),
    employee: spawn.employee,
    ...(spawn.engine ? { engine: spawn.engine } : {}),
    ...(spawn.model ? { model: spawn.model } : {}),
    ...(spawn.effortLevel ? { effortLevel: spawn.effortLevel } : {}),
    provenance: { source: "hook", sourceRef: `hook:${payload.fireId}` },
  });
  if (!outcome.ok) return { status: "error", error: outcome.error };
  const sessionId = outcome.session.id;
  if (outcome.dispatched) return { status: "ok", sessionId };
  return { status: "error", sessionId, error: outcome.session.lastError ?? "the session was created but could not be started" };
}

/** Post the rendered, redacted text through the configured connector. */
export async function runNotifyAction(context: ApiContext, notify: BoardHookNotify, payload: HookPayload): Promise<ActionOutcome> {
  const connector = context.connectors.get(notify.connector);
  if (!connector) return { status: "error", error: `no connector "${notify.connector}" is configured` };
  const target = { channel: String(notify.channel), ...(notify.thread != null ? { thread: String(notify.thread) } : {}) };
  await connector.sendMessage(target, redactText(renderTemplate(notify.text, payload)));
  return { status: "ok" };
}
