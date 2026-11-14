#!/usr/bin/env node
// The binary the legacy name resolves to once the program has another name: it says so, then
// runs the current binary with the same arguments, environment and exit code.
import { forwarderNotice, forwardTarget } from "../src/cli/legacy-forwarder.js";

const notice = forwarderNotice();
if (notice) process.stderr.write(`${notice}\n`);
// The current binary only runs its command line when it is the file node started, which it is not here.
const { buildProgram } = (await import(forwardTarget())) as { buildProgram: () => { parseAsync: () => Promise<unknown> } };
await buildProgram().parseAsync();
