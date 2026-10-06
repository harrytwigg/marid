import { spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import { logger } from "../shared/logger.js";

/**
 * Waking a remote host before a turn needs it: a Wake-on-LAN packet, or the
 * operator's own wake command. Best-effort by nature; the reachability poll in
 * `remote-stage.ts` is the verdict.
 */

/** Send a Wake-on-LAN magic packet: 6 × 0xFF followed by the target MAC sixteen
 *  times. No dependency needed — it is 102 bytes on a broadcast UDP socket. */
export async function sendWakeOnLan(mac: string): Promise<void> {
  const hex = mac.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) throw new Error(`remote.wakeMac "${mac}" is not a 6-byte MAC address`);
  const bytes = Buffer.from(hex, "hex");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), Buffer.alloc(16 * 6)]);
  for (let i = 0; i < 16; i += 1) bytes.copy(packet, 6 + i * 6);

  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const done = (err?: Error) => {
      try { socket.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve();
    };
    socket.once("error", done);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // Port 9 (discard) is the conventional WoL destination; 7 is also used.
      socket.send(packet, 0, packet.length, 9, "255.255.255.255", (err) => done(err ?? undefined));
    });
  });
}

/** Signal a wake command and everything it started. POSIX uses the process
 *  group the spawn above detached; Windows has none, so it signals the shell
 *  directly (best-effort, as before). */
function killWakeTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  try { child.kill(signal); } catch { /* gone */ }
}

/** Run the operator's wake command, bounded by `timeoutMs`.
 *  Exported so the budget is testable directly: driving it through
 *  `ensureRemoteReady` means spawning real ssh probes, which are slow and can
 *  outlive the test as unhandled child errors. */
export async function runLocalWakeCommand(command: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    // `detached` on POSIX makes the shell lead its own process group, so the
    // timeout can reap the whole tree. Without it `child.kill` reaches only the
    // shell Node interposed, and a helper it forked (`sleep`, an ATX-button
    // script) survives holding the stdio pipes — the timer fires, but `close`
    // and this await still wait out the full command. No detached on Windows:
    // there is no process group to signal and it would only change spawn shape.
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    // Long by default: see `wakeTimeoutMs`. A wake command that presses a
    // physical power button does real work before the press, and killing it in
    // that window is worse than waiting — the host never comes up at all.
    const timer = setTimeout(() => {
      logger.warn(`remote wakeCommand exceeded ${Math.round(timeoutMs / 1000)}s and was killed`);
      killWakeTree(child, "SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      logger.warn(`remote wakeCommand failed to start: ${err instanceof Error ? err.message : String(err)}`);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A wake is best-effort by nature — the box may already be up, the plug
      // may report oddly. The reachability poll is the real verdict, so a
      // non-zero exit is logged and not treated as fatal.
      if (code !== 0) logger.warn(`remote wakeCommand exited ${code}: ${stderr.trim()}`);
      resolve();
    });
  });
}
