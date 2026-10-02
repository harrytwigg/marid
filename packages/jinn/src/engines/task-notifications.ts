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
