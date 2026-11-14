#!/usr/bin/env node
// A stand-in for `ssh` that runs the remote command HERE, as the remote host's
// shell would: the argv is recorded (FAKE_SSH_LOG, one JSON array per line),
// and everything after the destination is handed to `sh -c`, so the command the
// engine built (its quoting, its `cd`, its sourced env file, its pid file, its
// `exec env`) is what actually runs. Control commands (`sh -s …`, the script on
// stdin) work the same way.
//
// The remote command runs in a process group of its own and is not signalled
// when this client goes: a command with no tty is not signalled when its ssh
// channel closes, which is the property the engine's remote kill exists for.
import fs from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
const at = args.indexOf("--");
const command = args.slice(at + 2).join(" ");
const child = spawn("sh", ["-c", command], { stdio: "inherit", detached: true });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 255 : 0)));
// The client dying is all a signal does to ssh; the remote command carries on.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(255));
