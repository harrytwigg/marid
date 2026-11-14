#!/usr/bin/env node
// The binary the legacy name resolves to once the program has another name: it says so, then
// runs the current binary with the same arguments, environment and exit code.
import { forwarderNotice, forwardTarget } from "../src/cli/legacy-forwarder.js";

const notice = forwarderNotice();
if (notice) process.stderr.write(`${notice}\n`);
await import(forwardTarget());
