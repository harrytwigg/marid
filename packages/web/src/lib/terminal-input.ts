import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Input plumbing for the interactive CLI terminal.
 *
 * The terminal forwards what the operator does — keystrokes, pastes, mouse
 * reports — to the PTY as `{type:"input"}` frames on /ws/pty. Everything here
 * exists to make sure that is ALL it forwards.
 */

/** Largest `input` frame we send. The gateway drops frames over 64 KiB
 *  (PTY_INPUT_MAX_CHARS in gateway/pty-ws.ts); staying well under it means a
 *  large paste arrives as several frames instead of being silently dropped. */
export const TERMINAL_INPUT_CHUNK_CHARS = 32 * 1024;

/** Touch-first devices keep the display-only terminal (composer + keybar +
 *  swipe-to-scroll). A focusable xterm textarea swallows iOS swipes and pops
 *  the on-screen keyboard over the TUI, which is why stdin was disabled there
 *  in the first place. Only the primary pointer counts: a touchscreen laptop
 *  with a trackpad is a desktop. */
export function isCoarsePointer(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  try {
    return win?.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Stop xterm answering the TUI's terminal queries.
 *
 * With stdin enabled, xterm replies to device-attribute, cursor-position,
 * mode, colour and setting queries through the same onData stream as typing.
 * Every connected viewer would inject those replies into the PTY as if the
 * operator had typed them — N viewers, N copies, arriving whenever the browser
 * got round to parsing the query. opencode issues a dozen at startup.
 *
 * Nothing answered these before the terminal was interactive, and the TUIs
 * work without answers, so swallowing the queries keeps the PTY seeing exactly
 * what it saw before. A handler returning true consumes the sequence; OSC
 * handlers only consume the query form (`?`) so colour SETs still apply.
 */
const XTWINOPS_REPORTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

/** `suppress` decides per query. An operator shell passes "unless
 *  this viewer has focus", so the one viewer being typed into answers — the
 *  programs a shell runs expect replies — while the others stay silent. */
export function suppressTerminalQueryReplies(term: Pick<Terminal, "parser">, suppress: () => boolean = () => true): IDisposable[] {
  const p = term.parser;
  const consume = () => suppress();
  const disposables: IDisposable[] = [
    p.registerCsiHandler({ final: "c" }, consume), // DA1
    p.registerCsiHandler({ prefix: ">", final: "c" }, consume), // DA2
    p.registerCsiHandler({ prefix: "=", final: "c" }, consume), // DA3
    p.registerCsiHandler({ final: "n" }, consume), // DSR / CPR
    p.registerCsiHandler({ prefix: "?", final: "n" }, consume), // DEC DSR
    p.registerCsiHandler({ intermediates: "$", final: "p" }, consume), // DECRQM (ANSI)
    p.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, consume), // DECRQM (DEC)
    p.registerCsiHandler({ prefix: ">", final: "q" }, consume), // XTVERSION
    // XTWINOPS: only the report requests (window state/position/size, screen
    // size, titles). The other Ps values are actions, left to xterm.
    p.registerCsiHandler({ final: "t" }, (params) => XTWINOPS_REPORTS.has(Number(params[0])) && suppress()),
    p.registerDcsHandler({ intermediates: "$", final: "q" }, consume), // DECRQSS
    p.registerDcsHandler({ intermediates: "+", final: "q" }, consume), // XTGETTCAP
  ];
  // Any "?" consumes the whole sequence, including a set mixed into the same
  // OSC 4 payload: letting xterm reply to the query part is the worse outcome.
  for (const id of [4, 10, 11, 12, 17, 19, 104, 110, 111, 112]) {
    disposables.push(p.registerOscHandler(id, (data) => data.includes("?") && suppress()));
  }
  return disposables;
}

/** Focus in/out reports (`?1004`). They fire on every focus change of every
 *  viewer, so they carry no information about the operator's intent. */
export function isFocusReport(data: string): boolean {
  return data === "\x1b[I" || data === "\x1b[O";
}

/** Split a paste into frames under the gateway's cap without cutting a
 *  surrogate pair in half. Escape sequences may straddle frames: the PTY is a
 *  byte stream and reassembles them. */
export function chunkTerminalInput(data: string, max = TERMINAL_INPUT_CHUNK_CHARS): string[] {
  if (data.length <= max) return data ? [data] : [];
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

/** An SGR mouse report for pointer motion (no button change): bit 32 set, not
 *  a wheel event (bit 64). opencode enables any-motion tracking (`?1003`), so
 *  merely moving the pointer across the terminal produces a stream of these. */
export function isMotionReport(data: string): boolean {
  const m = SGR_MOUSE.exec(data);
  if (!m) return false;
  const code = Number(m[1]);
  return (code & 32) !== 0 && (code & 64) === 0;
}

export interface TerminalInputSender {
  push(data: string): void;
  /** Send any coalesced motion report now. */
  flush(): void;
  dispose(): void;
}

/**
 * Forward operator input, coalescing pointer motion to one report per frame.
 * A non-motion input first flushes the pending motion so the PTY still sees
 * events in the order they happened (move, then click at the new position).
 */
export function createTerminalInputSender(
  send: (data: string) => void,
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): TerminalInputSender {
  let pendingMotion: string | null = null;
  let handle: number | null = null;
  let disposed = false;

  const flush = () => {
    if (handle !== null) { cancel(handle); handle = null; }
    const motion = pendingMotion;
    pendingMotion = null;
    if (motion !== null && !disposed) send(motion);
  };

  return {
    push(data: string) {
      if (disposed || !data || isFocusReport(data)) return;
      if (isMotionReport(data)) {
        pendingMotion = data;
        if (handle === null) handle = schedule(() => { handle = null; flush(); });
        return;
      }
      flush();
      for (const chunk of chunkTerminalInput(data)) send(chunk);
    },
    flush,
    dispose() {
      disposed = true;
      pendingMotion = null;
      if (handle !== null) { cancel(handle); handle = null; }
    },
  };
}

/**
 * Track whether the program asked for SGR mouse encoding (`?1006`). xterm does
 * not expose the encoding publicly, and a swipe on a touch device can only be
 * turned into wheel reports if we know which encoding the program parses.
 * The handlers return false so xterm still applies the mode itself.
 */
export function trackSgrMouseMode(term: Pick<Terminal, "parser">): { readonly enabled: boolean; disposables: IDisposable[] } {
  const state = { enabled: false, disposables: [] as IDisposable[] };
  const has1006 = (params: (number | number[])[]) => params.some((p) => p === 1006 || (Array.isArray(p) && p.includes(1006)));
  state.disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => { if (has1006(params)) state.enabled = true; return false; }),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => { if (has1006(params)) state.enabled = false; return false; }),
  );
  return state;
}

/** SGR wheel reports for a touch swipe of `lines` (positive = toward newer
 *  content, i.e. wheel down) at a 1-based cell. */
export function wheelReports(lines: number, col: number, row: number): string {
  const button = lines > 0 ? 65 : 64;
  return `\x1b[<${button};${col};${row}M`.repeat(Math.abs(Math.trunc(lines)));
}
