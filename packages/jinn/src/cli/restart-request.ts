import fs from "node:fs";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";
import { portOwnedByThisInstance, resolveLocalGatewayConnection } from "../gateway/lifecycle.js";
import { JINN_HOME } from "../shared/paths.js";

interface GatewayConnection {
  port: number;
  host?: string;
  token: string;
}

function gatewayConnection(): GatewayConnection | null {
  if (!fs.existsSync(JINN_HOME)) return null;
  const info = resolveLocalGatewayConnection(JINN_HOME);
  const token = info.token;
  if (!token) return null;
  return { port: info.port, host: info.host, token };
}

export interface RestartRequestOptions {
  /** The port the caller is acting on; the home's configured binding otherwise. */
  port?: number;
  /** Ownership check for the listener on that port. */
  isOwnGateway?: (port: number) => boolean;
}

/**
 * Ask this instance's running gateway to restart itself. The request carries this
 * home's bearer token and makes the gateway on the target port restart, so it is only
 * sent to a listener verified as this instance's own: a home that shares a port with
 * another instance must never restart that instance.
 */
export async function requestRestartFromGateway(
  fetchImpl: typeof fetch = fetch,
  options: RestartRequestOptions = {},
): Promise<boolean> {
  const resolved = gatewayConnection();
  if (!resolved) return false;
  const connection = options.port === undefined ? resolved : { ...resolved, port: options.port };
  if (!(options.isOwnGateway ?? portOwnedByThisInstance)(connection.port)) return false;
  const currentSessionId = process.env.JINN_SESSION_ID?.trim();

  try {
    const res = await fetchImpl(`${gatewayBaseUrl(connection)}/api/system/restart`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
        ...(currentSessionId ? { "x-jinn-session-id": currentSessionId } : {}),
      },
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
