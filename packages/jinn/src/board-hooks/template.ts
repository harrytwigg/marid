import type { HookPayload } from "./types.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function valueAt(payload: HookPayload, path: string): unknown {
  if (path === "payload") return payload;
  let value: unknown = payload;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Replace `{{path}}` with the payload value at that dotted path. No logic: a missing path is empty, objects are JSON. */
export function renderTemplate(template: string, payload: HookPayload): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => asText(valueAt(payload, path)));
}

/** A fence longer than any backtick run in `body`, so the payload cannot close it early. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The spawn prompt: the rendered template (or a default), then the whole payload in a fenced `json` block. */
export function renderSpawnPrompt(template: string | undefined, payload: HookPayload): string {
  const head = template && template.trim()
    ? renderTemplate(template, payload)
    : `Board hook "${payload.hook}" fired on ${payload.event} for ${payload.todo.id}: ${payload.todo.title}.`;
  const body = JSON.stringify(payload, null, 2);
  const fence = fenceFor(body);
  return `${head}\n\n${fence}json\n${body}\n${fence}`;
}
