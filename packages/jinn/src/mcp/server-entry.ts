#!/usr/bin/env node
/**
 * Launchable entry for the `jinn` MCP stdio server (GRS-012b).
 *
 * MCP-capable engines spawn this as a stdio subprocess (command = node, args =
 * [this file]) and speak JSON-RPC to it. It reads its gateway URL/token from the
 * inherited environment (see {@link runJinnMcpServer}); no argv secret.
 */
import "../shared/adopt-legacy-env-entry.js";
import { runJinnMcpServer } from "./server.js";
import { resolveMcpServerBootstrap } from "./server-bootstrap.js";
import { setEnv } from "../shared/codename-env.js";
import { scrubListedEnv } from "./scrub-list-env.js";

// An opencode parent lists the account keys it holds (JINN_SCRUB_ENV); this server and the tools it hands out have no use for them.
scrubListedEnv(process.env);

const bootstrap = resolveMcpServerBootstrap(process.argv.slice(2));
if (bootstrap.jinnHome) setEnv(process.env, "HOME", bootstrap.jinnHome);
runJinnMcpServer(bootstrap);
