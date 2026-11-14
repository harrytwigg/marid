import { logger } from "../shared/logger.js";
import type { Connector, IncomingMessage } from "../shared/types.js";
import { scopedDepartmentOf } from "../work-items/department-scope.js";

/**
 * Connector-originated sessions (Telegram and the like) for a department-scoped
 * employee are refused in v1: a connector session is company-wide by nature, and
 * nothing would hold its replies or its routing to the department. The sender is
 * told why; no session is created.
 */
export function refuseScopedConnectorSession(msg: IncomingMessage, employee: string | undefined, connector: Connector): boolean {
  const department = scopedDepartmentOf(employee);
  if (!department || msg.source === "web") return false;
  const reason = `${employee} is confined to department "${department}" and cannot be reached through ${connector.name}; start the session from the dashboard instead.`;
  logger.warn(`Refused a ${msg.source} session for ${employee}: ${reason}`);
  void Promise.resolve(connector.sendMessage(connector.reconstructTarget(msg.replyContext), reason)).catch(() => undefined);
  return true;
}
