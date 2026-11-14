import path from "node:path";
import { gatewayEnvOverrides, gatewayFileBinding } from "../shared/config.js";
import { resolveHomeIdentity, resolveHundredfoldHome } from "../shared/home.js";
import { readGatewayInfo } from "./gateway-info.js";

export interface LocalGatewayConnection {
  host?: string;
  port: number;
  token?: string;
}

/**
 * Local CLI commands use the durable instance config plus the supported process
 * environment overrides for routing. gateway.json contributes only the bearer
 * credential: its host, port, pid, and URL are ephemeral runtime metadata and
 * never override the configured endpoint.
 */
export function resolveLocalGatewayConnection(
  home: string,
  registryPort = 7777, // footgun: ok the CLI's pre-existing fallback for a home whose config.yaml records no port
  env: NodeJS.ProcessEnv = process.env,
): LocalGatewayConnection {
  const recorded = readGatewayInfo(path.join(home, "gateway.json"));
  const onFile = gatewayFileBinding(path.join(home, "config.yaml"));
  // HUNDREDFOLD_HOST/HUNDREDFOLD_PORT describe the binding of the instance this process belongs to.
  // Read against a different home they name the wrong gateway, which is how a sandbox
  // `hundredfold pair` sent its challenge to the live port with a leaked HUNDREDFOLD_PORT.
  const bindsThisHome = resolveHomeIdentity(resolveHundredfoldHome(env)) === resolveHomeIdentity(home);
  const overrides = bindsThisHome ? gatewayEnvOverrides(env) : {};
  return {
    port: overrides.port ?? onFile.port ?? registryPort,
    host: overrides.host ?? onFile.host,
    token: recorded?.token,
  };
}
