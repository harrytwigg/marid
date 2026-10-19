import path from "node:path";
import {
  deriveExistingSessionCapability,
  JINN_SESSION_CAPABILITY_ENV,
  JINN_SESSION_ID_ENV,
} from "./identity.js";
import { resolveMcpSessionCapabilityKeyFile } from "../shared/home.js";
import { mcpFlagAliases } from "../shared/wire-names.js";

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
  // A config staged by an earlier build names its flags under that build's codename.
  const valueAfter = (suffix: string): string | undefined => {
    for (const candidate of mcpFlagAliases(suffix)) {
      const index = argv.indexOf(candidate);
      const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
      if (value) return value;
    }
    return undefined;
  };
  const callerSessionId = valueAfter("session-id");
  const homeArg = valueAfter("home");
  const jinnHome = homeArg ? path.resolve(homeArg) : undefined;
  const gatewayUrl = valueAfter("gateway-url");
  const sessionCapability = callerSessionId ? boundCapability(callerSessionId, jinnHome, env) : undefined;
  const toolset = valueAfter("toolset");
  return { callerSessionId, sessionCapability, gatewayUrl, jinnHome, ...(toolset ? { toolset } : {}) };
}

/**
 * The capability this server presents for `sessionId`.
 *
 * The one the gateway stamped on the server's env for that same session wins: it
 * was minted with the gateway's key, which is the only key the gateway verifies
 * against. Only when an engine stripped the env does the server derive it from
 * `--jinn-home`'s key, and then read-only. A home with no key (a department-
 * scoped remote stage has no path to the gateway's) yields nothing here, and the
 * server falls back to whatever its env carries: none, and the tools refuse
 * locally; another session's, and the gateway refuses it. It never mints a key
 * of its own and presents a capability the gateway can never verify.
 */
function boundCapability(sessionId: string, jinnHome: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const stamped = env[JINN_SESSION_CAPABILITY_ENV]?.trim();
  if (stamped && env[JINN_SESSION_ID_ENV]?.trim() === sessionId) return stamped;
  return jinnHome ? deriveExistingSessionCapability(sessionId, resolveMcpSessionCapabilityKeyFile(jinnHome)) : undefined;
}
