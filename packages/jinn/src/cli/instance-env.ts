import { InvalidArgumentError } from "commander";
import { dropForeignInstanceEnv } from "../shared/sandbox-env.js";

/** `--port` value: a whole number from 1 to 65535, rejected rather than defaulted. */
export function parsePortOption(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError("must be a port number between 1 and 65535");
  }
  return port;
}

/**
 * JINN_HOME pointed at another home from inside a session: the binding and session the
 * process inherited belong to the gateway that spawned it, not to the home it targets.
 * Drop them, and say so when the port was among them.
 */
export function dropInheritedBinding(env: NodeJS.ProcessEnv = process.env): void {
  const inheritedPort = env.JINN_PORT;
  const inheritedFrom = env.JINN_BINDING_HOME;
  if (!dropForeignInstanceEnv(env).includes("JINN_PORT")) return;
  console.error(
    `Ignoring JINN_PORT=${inheritedPort}: it is the port of the instance at ${inheritedFrom}, whose session`
    + ` this ran in, not of ${env.JINN_HOME}. Using that home's own config.yaml instead.`,
  );
}
