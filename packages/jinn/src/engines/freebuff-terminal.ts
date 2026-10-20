import headlessXterm from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

// @xterm/headless 6 publishes CommonJS at its Node `main`; see pty-snapshot.ts.
const { Terminal } = headlessXterm;

export const FREEBUFF_COLS = 160;
export const FREEBUFF_ROWS = 48;

/**
 * Freebuff has no print or JSON mode, so the only thing that says what it is
 * doing is its rendered screen. This is that screen: the PTY's bytes go in, the
 * visible rows come out as plain text. Nothing downstream reads raw ANSI.
 *
 * Wider than the dashboard's default on purpose: the status bar wraps its chat
 * title and `/model to change` can be split across lines on a narrow terminal.
 */
export class FreebuffTerminal {
  private readonly terminal: HeadlessTerminal;
  private pending = 0;
  private waiters: Array<() => void> = [];

  constructor(cols = FREEBUFF_COLS, rows = FREEBUFF_ROWS) {
    this.terminal = new Terminal({ cols, rows, scrollback: 0, convertEol: true, allowProposedApi: true });
  }

  /** Queue bytes; they are on the screen once {@link settled} resolves. */
  write(data: string | Buffer): void {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    this.pending++;
    this.terminal.write(text, () => {
      this.pending--;
      if (this.pending === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
      }
    });
  }

  /** Resolves when every byte written so far has been applied to the screen. */
  settled(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** The visible rows, each with trailing blanks trimmed. */
  lines(): string[] {
    const buffer = this.terminal.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.terminal.rows; y++) {
      out.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
    }
    return out;
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** Render a screen the way an error message or a log wants it: no blank tail. */
export function dumpScreen(lines: readonly string[]): string {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end).join("\n");
}
