/** Task ids of the finished background tasks announced by the
 *  `<task-notification>` blocks in `text`. A notification without a `<status>`
 *  (a Monitor's per-event notice) is not an ending. Its own module so the
 *  proxy and the engine's hook path share it, and a test that mocks the proxy
 *  does not take it away from the engine. */
export function finishedTaskNotificationIds(text: string): string[] {
  const ids: string[] = [];
  for (const [, body] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>([^<\s]+)<\/task-id>/.exec(body)?.[1];
    if (id && /<status>[^<]+<\/status>/.test(body)) ids.push(id);
  }
  return ids;
}

/** A Monitor's event as its `<task-notification>` carries it. */
export interface MonitorEventNotice {
  taskId: string;
  /** The last non-empty line of the event, trimmed, at most 300 characters. */
  line: string | null;
  /** The Monitor's timeout elapsed: the CLI says so as one more event, not as a status. */
  expired: boolean;
}

const EVENT_LINE_MAX = 300;
const MONITOR_EXPIRED = /^\[Monitor expired after\b/;

/** The Monitor events announced by the `<task-notification>` blocks in `text`: the blocks with no
 *  `<status>` (an ending is `finishedTaskNotificationIds`' business). */
export function monitorEventNotices(text: string): MonitorEventNotice[] {
  const notices: MonitorEventNotice[] = [];
  for (const [, body] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const taskId = /<task-id>([^<\s]+)<\/task-id>/.exec(body)?.[1];
    if (!taskId || /<status>[^<]+<\/status>/.test(body)) continue;
    const event = [...body.matchAll(/<event>([\s\S]*?)<\/event>/g)].at(-1)?.[1] ?? "";
    const line = event.split("\n").map((part) => part.trim()).filter(Boolean).at(-1)?.slice(0, EVENT_LINE_MAX) ?? null;
    notices.push({ taskId, line, expired: line !== null && MONITOR_EXPIRED.test(line) });
  }
  return notices;
}
