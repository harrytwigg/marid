import path from "node:path";
import {
  deriveExistingSessionCapability,
  JINN_SESSION_CAPABILITY_ENV,
  JINN_SESSION_ID_ENV,
  MCP_GATEWAY_URL_ARG,
  MCP_HOME_ARG,
  MCP_SESSION_ID_ARG,
  MCP_TOOLSET_ARG,
} from "./identity.js";
import { resolveMcpSessionCapabilityKeyFile } from "../shared/home.js";

export interface McpServerBootstrap {
  callerSessionId?: string;
  sessionCapability?: string;
  gatewayUrl?: string;
  jinnHome?: string;
  /** The purpose-built toolset to serve instead of the company belt. */
  toolset?: string;
}

/** Resolve the built-in MCP server's scoped identity from non-secret argv, and the env the gateway stamped. */
export function resolveMcpServerBootstrap(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): McpServerBootstrap {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
    return value || undefined;
  };
  const callerSessionId = valueAfter(MCP_SESSION_ID_ARG);
  const homeArg = valueAfter(MCP_HOME_ARG);
  const jinnHome = homeArg ? path.resolve(homeArg) : undefined;
  const gatewayUrl = valueAfter(MCP_GATEWAY_URL_ARG);
  const sessionCapability = callerSessionId ? boundCapability(callerSessionId, jinnHome, env) : undefined;
  const toolset = valueAfter(MCP_TOOLSET_ARG);
  return { callerSessionId, sessionCapability, gatewayUrl, jinnHome, ...(toolset ? { toolset } : {}) };
}

/**
 * The capability this server presents for `sessionId`.
 *
 * The one the gateway stamped on the server's env for that same session wins: it
 * was minted with the gateway's key, which is the only key the gateway verifies
 * against. Only when an engine stripped the env does the server derive it from
 * `--jinn-home`'s key, and then read-only — a home with no key (a department-
 * scoped remote stage has no path to the gateway's) yields no capability, and
 * the tools fail closed with a message saying so, rather than minting a key of
 * their own and presenting a capability the gateway can never verify.
 */
function boundCapability(sessionId: string, jinnHome: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const stamped = env[JINN_SESSION_CAPABILITY_ENV]?.trim();
  if (stamped && env[JINN_SESSION_ID_ENV]?.trim() === sessionId) return stamped;
  return jinnHome ? deriveExistingSessionCapability(sessionId, resolveMcpSessionCapabilityKeyFile(jinnHome)) : undefined;
}
