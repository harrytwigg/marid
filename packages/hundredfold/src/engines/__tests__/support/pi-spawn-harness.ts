import { PassThrough } from "node:stream";

/**
 * The fake child process the pi suites drive `spawn` with, plus the two helpers
 * that go with it. Vitest module mocks are per-file, so `pi.test.ts` and
 * `pi-mcp-attach.test.ts` each build their own `spawn` factory over this shape.
 */
export interface FakeProc {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: {
    on: (event: string, cb: (...a: any[]) => void) => void;
    write: (chunk: string) => void;
    end: () => void;
  };
  stdinWrites: string[];
  stdinEnded: boolean;
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  close: (code: number | null) => void;
}

export interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

export function makeFakeProc(): FakeProc {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout,
    stderr,
    stdin: {
      on: () => {},
      write: (chunk: string) => { p.stdinWrites.push(chunk); },
      end: () => { p.stdinEnded = true; },
    },
    stdinWrites: [],
    stdinEnded: false,
    exitCode: null,
    killed: false,
    pid: 8888,
    kill: () => {
      p.killed = true;
      return true;
    },
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return p;
    },
    emitStdout(s) {
      stdout.write(Buffer.from(s));
    },
    emitStderr(s) {
      stderr.write(Buffer.from(s));
    },
    close(code) {
      p.exitCode = code;
      handlers.close?.(code);
    },
  };
  return p;
}

/** Let the engine's readline/stream handlers run before asserting. */
export const flush = () => new Promise((r) => setTimeout(r, 0));

/** The terminating pi event carrying the final assistant answer. */
export const agentEnd = (text: string) => JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [{ type: "text", text }],
  }],
});
