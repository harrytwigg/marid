import { EventEmitter } from "node:events";
import type {
  PtyControlEvent,
  PtyIdleSpawnOpts,
  PtyInitialSnapshot,
  PtySnapshotSubscription,
  PtyViewEngine,
} from "../../../engines/pty-view-engine.js";

/** A WebSocket and a PTY view engine that record what `attachPtyWebSocket` does to them. */
export class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: Array<string | Buffer> = [];
  closed = false;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

export function controls(ws: FakeWebSocket): any[] {
  return ws.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value));
}

export class FakeEngine implements PtyViewEngine {
  warm = false;
  spawnCalls: PtyIdleSpawnOpts[] = [];
  restartCalls: PtyIdleSpawnOpts[] = [];
  viewingCalls: boolean[] = [];
  started = false;
  unsubscribed = false;
  onData?: (data: Buffer) => void;
  onControl?: (event: PtyControlEvent) => void;
  initial: PtyInitialSnapshot = {
    snapshot: { data: "persisted screen", cols: 90, rows: 30, visible: true },
    ready: true,
  };
  queuedOnStart: Buffer[] = [];

  hasWarmPty(): boolean { return this.warm; }
  ensureIdleSpawn(_sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.spawnCalls.push(opts);
    this.warm = true;
  }
  restartPty(_sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.restartCalls.push(opts);
    this.warm = true;
  }
  subscribeWithSnapshot(
    _sessionId: string,
    onData: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    this.onData = onData;
    this.onControl = onControl;
    return {
      snapshot: Promise.resolve(this.initial),
      start: () => {
        this.started = true;
        for (const data of this.queuedOnStart.splice(0)) onData(data);
      },
      unsubscribe: () => { this.unsubscribed = true; },
    };
  }
  setViewing(_sessionId: string, viewing: boolean): void { this.viewingCalls.push(viewing); }
  stdinWrites: string[] = [];
  rawWrites: string[] = [];
  writeStdin(_sessionId: string, text: string): void { this.stdinWrites.push(text); }
  writeRaw(_sessionId: string, data: string): void { this.rawWrites.push(data); }
  resizePty(): void {}
}

export async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
