import net from "node:net";
import { patchConfigFile } from "../shared/config-document.js";
import { gatewayEnvOverrides, gatewayFileBinding } from "../shared/config.js";
import { CONFIG_PATH, GATEWAY_INFO_FILE, JINN_HOME_IDENTITY } from "../shared/paths.js";
import { readGatewayInfo, recordedByAnotherHome } from "../gateway/gateway-info.js";
import { pidBelongsToAnotherHome } from "../gateway/process-home.js";

/** True when nothing on this machine is listening on `port` at the loopback address. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

/** This home's own gateway is the one listening — re-running setup on a live home. A
 *  gateway.json copied from another running instance's home vouches for nothing. */
function ownGatewayHolds(port: number): boolean {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  if (!info || info.port !== port || !info.pid) return false;
  if (recordedByAnotherHome(info, JINN_HOME_IDENTITY) || pidBelongsToAnotherHome(info.pid)) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** How setup prints its checklist lines. */
export interface SetupReport {
  ok(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

/**
 * Record the requested port, and say plainly which port `jinn start` will use. A home
 * left on the default port beside a running instance otherwise starts on that
 * instance's port — the one thing a second, throwaway home must never do.
 *
 * A fresh home also takes its port from JINN_PORT: that is the caller asking for it.
 * An existing home keeps what it records, and a container's JINN_PORT is the published
 * binding of that process, never saved (see gatewayEnvOverrides).
 */
export async function settleGatewayPort(
  requested: number | undefined,
  { fresh = false, report }: { fresh?: boolean; report: SetupReport },
): Promise<void> {
  const container = process.env.JINN_CONTAINER === "1";
  const envPort = container ? undefined : gatewayEnvOverrides().port;
  const fromEnv = requested === undefined && fresh && envPort !== undefined;
  const recorded = fromEnv ? envPort : requested;
  if (recorded !== undefined) recordPort(recorded, fromEnv, report);
  const port = gatewayFileBinding(CONFIG_PATH).port ?? 7777;
  if (recorded === undefined) warnUnsavedEnvPort(envPort, port, report);
  await warnPortInUse(port, report);
}

async function warnPortInUse(port: number, report: SetupReport): Promise<void> {
  if (await portIsFree(port) || ownGatewayHolds(port)) return;
  report.warn(`Port ${port} is already in use on this machine. If another instance owns it, \`jinn start\` here will refuse to run.`);
  report.info("Give this home its own port with: jinn setup --port <port>");
}

function warnUnsavedEnvPort(envPort: number | undefined, port: number, report: SetupReport): void {
  if (envPort === undefined || envPort === port) return;
  report.warn(`JINN_PORT=${envPort} only applies to processes that carry it; it is not saved. This home's config.yaml says port ${port}.`);
  report.info(`To record ${envPort} for this home, run: jinn setup --port ${envPort}`);
}

function recordPort(port: number, fromEnv: boolean, report: SetupReport): void {
  if (gatewayFileBinding(CONFIG_PATH).port !== port) {
    patchConfigFile(CONFIG_PATH, [{ path: ["gateway", "port"], value: port }]);
  }
  report.ok(`Gateway port ${port}${fromEnv ? " (from JINN_PORT)" : ""} recorded in ${CONFIG_PATH}`);
}
