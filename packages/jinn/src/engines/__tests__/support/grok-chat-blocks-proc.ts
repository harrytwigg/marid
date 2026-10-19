import { EventEmitter } from "node:events";

/** Fake grok child used by the live mid-turn Grok tests. Kept off GrokEngine so the
 *  `node:child_process` mock can load it without a cycle. */

export interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: () => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
}

export const spawnCalls: FakeProc[] = [];

export function makeFakeProc(): FakeProc {
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 6464,
    kill: () => true,
    _handlers: handlers,
    on(event, cb) { handlers[event] = cb; return p; },
    emitStdout(s) { p.stdout.emit("data", Buffer.from(s)); },
  };
  return p;
}
