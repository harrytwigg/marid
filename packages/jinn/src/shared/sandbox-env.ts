import os from "node:os";
import path from "node:path";
import { resolveHomeIdentity, resolveJinnHome } from "./home.js";

/**
 * The variables that name WHICH Jinn instance a process belongs to: its home, its
 * binding, and the credentials of the gateway session that launched it. A process
 * pointed at a different instance must inherit none of them — read against another
 * home they route the work straight back to the instance they came from.
 */
export const JINN_INSTANCE_IDENTITY_ENV_KEYS = [
  "JINN_HOME",
  "JINN_HOME_IDENTITY",
  "JINN_INSTANCE",
  "JINN_HOST",
  "JINN_PORT",
  "JINN_GATEWAY_URL",
  "JINN_GATEWAY_TOKEN",
  "JINN_SESSION_ID",
  "JINN_SESSION_CAPABILITY",
  "JINN_TAKE_PORT",
  "JINN_BINDING_HOME",
] as const;

/**
 * Names the home whose binding JINN_HOST/JINN_PORT describe. A gateway sets it on its
 * own environment, so every session it spawns — and every command run from one —
 * carries it beside the binding it inherited.
 */
export const JINN_BINDING_HOME_ENV = "JINN_BINDING_HOME";

/** Ports a live gateway owns: the default instance, and the demo instance beside it. */
export const PRODUCTION_GATEWAY_PORTS: readonly number[] = [7777, 7788]; // footgun: ok this list is the refusal set itself — naming the live ports is what it is for

export interface JinnInstanceTarget {
  home: string;
  instance?: string;
  host?: string;
  port?: number;
  gatewayUrl?: string;
  token?: string;
}

/**
 * The environment for a child that belongs to `target`. Everything unrelated is
 * inherited; every instance-identity variable is dropped and then re-set from the
 * target alone, so nothing the parent instance owns reaches the child.
 */
export function buildSandboxChildEnv(
  target: JinnInstanceTarget,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const identity: ReadonlySet<string> = new Set(JINN_INSTANCE_IDENTITY_ENV_KEYS);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (identity.has(key) || value === undefined) continue;
    env[key] = value;
  }
  env.JINN_HOME = path.resolve(target.home);
  if (target.instance) env.JINN_INSTANCE = target.instance;
  if (target.host) env.JINN_HOST = target.host;
  if (target.port !== undefined) env.JINN_PORT = String(target.port);
  if (target.gatewayUrl) env.JINN_GATEWAY_URL = target.gatewayUrl;
  if (target.token) env.JINN_GATEWAY_TOKEN = target.token;
  return env;
}

/**
 * Point this process at `target` in place, before any module resolves paths from the
 * environment. Identity inherited from a DIFFERENT instance is dropped: a leaked
 * JINN_PORT from the enclosing gateway session otherwise outranks the target home's
 * own config.yaml, which is how a sandbox `jinn pair` reached the live gateway.
 *
 * A target that is already this process's own instance keeps its binding, so the
 * JINN_HOST/JINN_PORT a container publishes still describe the home they name.
 */
export function retargetInstanceEnv(
  target: Pick<JinnInstanceTarget, "home" | "instance">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const home = path.resolve(target.home);
  if (resolveHomeIdentity(resolveJinnHome(env)) !== resolveHomeIdentity(home)) {
    for (const key of JINN_INSTANCE_IDENTITY_ENV_KEYS) delete env[key];
  }
  env.JINN_HOME = home;
  if (target.instance) env.JINN_INSTANCE = target.instance;
}

/**
 * Drop instance identity this process inherited from a DIFFERENT instance, in place.
 *
 * A session inherits its gateway's JINN_HOST/JINN_PORT and credentials. Running
 * `JINN_HOME=<sandbox> jinn start` from one keeps them, and JINN_PORT then outranks the
 * sandbox's own config.yaml: the command acts on the live gateway's port. JINN_HOME was
 * pointed at the sandbox on purpose, so it stays; everything that described the instance
 * it was pointed away from goes. A JINN_PORT that differs from that instance's own port
 * (the one its JINN_GATEWAY_URL names) was set for this command, and stays too.
 * Returns the keys it removed.
 */
export function dropForeignInstanceEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const bindingHome = env[JINN_BINDING_HOME_ENV]?.trim();
  if (!bindingHome) return [];
  const home = resolveJinnHome(env);
  if (resolveHomeIdentity(bindingHome) === resolveHomeIdentity(home)) return [];
  const kept = new Set<string>(["JINN_HOME", ...(portSetForThisCommand(env) ? ["JINN_PORT"] : [])]);
  const dropped = JINN_INSTANCE_IDENTITY_ENV_KEYS.filter((key) => env[key] !== undefined && !kept.has(key));
  for (const key of dropped) delete env[key];
  env.JINN_HOME = home;
  return dropped;
}

/** JINN_PORT differs from the port of the gateway that spawned this process, as its
 *  JINN_GATEWAY_URL records it. With no URL to compare against, it cannot be told apart. */
function portSetForThisCommand(env: NodeJS.ProcessEnv): boolean {
  const port = env.JINN_PORT?.trim();
  if (!port) return false;
  try {
    const spawner = new URL(env.JINN_GATEWAY_URL ?? "").port;
    return spawner !== "" && spawner !== port;
  } catch {
    return false;
  }
}

/**
 * Refuse a target that would drive a live gateway. Sandboxes exist so that a wrong
 * guess costs a temp directory rather than the operator's instance, and the two
 * values that decide which one is being driven are the home and the port.
 */
export function assertNotProductionGateway(target: { home?: string; port?: number }): void {
  if (target.port !== undefined && PRODUCTION_GATEWAY_PORTS.includes(target.port)) {
    throw new Error(
      `Refusing to use port ${target.port}: a live gateway owns it. ` +
      `Sandbox work needs a throwaway port (7800 and up).`,
    );
  }
  if (target.home === undefined) return;
  const home = path.resolve(target.home);
  if (resolveHomeIdentity(home) === resolveHomeIdentity(defaultInstanceHome())) {
    throw new Error(
      `Refusing to use ${home}: it is the default instance home. ` +
      `Point JINN_HOME at a throwaway directory for sandbox work.`,
    );
  }
}

function defaultInstanceHome(): string {
  // Deliberately not resolveJinnHome(): a sandbox sets JINN_HOME, so honouring it would
  // make the sandbox "production" and wave the real home through.
  return path.join(os.homedir(), ".jinn"); // footgun: ok the canary must know the default home even when JINN_HOME names another
}
