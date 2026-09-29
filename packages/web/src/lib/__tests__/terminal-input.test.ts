import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  TERMINAL_INPUT_CHUNK_CHARS,
  chunkTerminalInput,
  createTerminalInputSender,
  isCoarsePointer,
  isFocusReport,
  isMotionReport,
  suppressTerminalQueryReplies,
  trackSgrMouseMode,
  wheelReports,
} from "../terminal-input";

/** The queries a TUI sends at startup, as captured from opencode 1.18.31 and
 *  claude 2.1.283 on build-host, plus the rest of the reply family. */
const QUERIES = [
  "\x1b[c", // DA1
  "\x1b[>c", // DA2
  "\x1b[6n", // CPR
  "\x1b[5n", // DSR
  "\x1b[?2026$p", // DECRQM (DEC)
  "\x1b[4$p", // DECRQM (ANSI)
  "\x1b]10;?\x1b\\", // OSC 10 foreground query
  "\x1b]11;?\x07", // OSC 11 background query
  "\x1b]4;0;?\x1b\\", // OSC 4 palette query
  "\x1bP$qm\x1b\\", // DECRQSS
  // The rest of the family. xterm 6 answers some of these only under options
  // we do not set; asserting silence for them still pins the handlers.
  "\x1b[=c", // DA3
  "\x1b[>0q", // XTVERSION
  "\x1bP+q544e\x1b\\", // XTGETTCAP "TN"
  "\x1b[14t", "\x1b[18t", "\x1b[21t", // XTWINOPS reports
  "\x1b]12;?\x07", "\x1b]17;?\x07", "\x1b]19;?\x07", // OSC cursor/highlight colour queries
];

async function repliesTo(data: string, suppress: boolean): Promise<string[]> {
  const term = new Terminal({ allowProposedApi: true });
  if (suppress) suppressTerminalQueryReplies(term);
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  await new Promise<void>((resolve) => term.write(data, resolve));
  term.dispose();
  return replies;
}

describe("suppressTerminalQueryReplies (real xterm parser)", () => {
  it("control: without suppression xterm answers the queries through onData", async () => {
    const replies = await repliesTo(QUERIES.join(""), false);
    // If this ever drops to zero the suppression test below proves nothing.
    expect(replies.length).toBeGreaterThanOrEqual(6);
  });

  it("with suppression, no query produces a reply", async () => {
    for (const query of QUERIES) {
      expect(await repliesTo(query, true), JSON.stringify(query)).toEqual([]);
    }
  });

  it("leaves XTWINOPS actions to xterm (only the report requests are consumed)", () => {
    const term = new Terminal({ allowProposedApi: true });
    const handlers: Array<{ id: { final: string }; cb: (params: (number | number[])[]) => boolean }> = [];
    suppressTerminalQueryReplies({
      parser: {
        registerCsiHandler: (id: { final: string }, cb: (params: (number | number[])[]) => boolean) => { handlers.push({ id, cb }); return { dispose() {} }; },
        registerDcsHandler: () => ({ dispose() {} }),
        registerOscHandler: () => ({ dispose() {} }),
      },
    } as never);
    const winops = handlers.find((h) => h.id.final === "t" && Object.keys(h.id).length === 1)!;
    for (const report of [11, 13, 14, 15, 16, 18, 19, 20, 21]) expect(winops.cb([report]), `report ${report}`).toBe(true);
    for (const action of [1, 2, 8, 22, 23]) expect(winops.cb([action]), `action ${action}`).toBe(false);
    term.dispose();
  });

  it("answers through a predicate: an operator shell's focused viewer replies, the rest stay silent", async () => {
    let focused = false;
    const term = new Terminal({ allowProposedApi: true });
    suppressTerminalQueryReplies(term, () => !focused);
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    const write = (d: string) => new Promise<void>((resolve) => term.write(d, resolve));
    await write("\x1b[c\x1b[6n\x1b[18t");
    expect(replies).toEqual([]);
    focused = true;
    await write("\x1b[c\x1b[6n");
    expect(replies.length).toBe(2);
    term.dispose();
  });

  it("still applies what is not a query: text, colour SETs, modes", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 3 });
    suppressTerminalQueryReplies(term);
    await new Promise<void>((resolve) => term.write("\x1b]11;#102030\x07hello\x1b[?1049h", resolve));
    expect(term.buffer.active.type).toBe("alternate");
    term.write("\x1b[?1049l");
    await new Promise<void>((resolve) => term.write("", resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
    term.dispose();
  });
});

describe("trackSgrMouseMode", () => {
  it("follows ?1006 set/reset without consuming the sequence", async () => {
    const term = new Terminal({ allowProposedApi: true });
    const sgr = trackSgrMouseMode(term);
    const write = (d: string) => new Promise<void>((resolve) => term.write(d, resolve));
    expect(sgr.enabled).toBe(false);
    await write("\x1b[?1000;1006h");
    expect(sgr.enabled).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe("vt200"); // xterm still applied it
    await write("\x1b[?1006l");
    expect(sgr.enabled).toBe(false);
    term.dispose();
  });
});

describe("input helpers", () => {
  it("recognises focus reports only", () => {
    expect(isFocusReport("\x1b[I")).toBe(true);
    expect(isFocusReport("\x1b[O")).toBe(true);
    expect(isFocusReport("\x1bOP")).toBe(false); // F1 (SS3)
    expect(isFocusReport("\x1b[Z")).toBe(false); // Shift+Tab
  });

  it("classifies SGR motion reports", () => {
    expect(isMotionReport("\x1b[<35;10;5M")).toBe(true); // move, no button
    expect(isMotionReport("\x1b[<32;10;5M")).toBe(true); // drag, left held
    expect(isMotionReport("\x1b[<0;10;5M")).toBe(false); // press
    expect(isMotionReport("\x1b[<0;10;5m")).toBe(false); // release
    expect(isMotionReport("\x1b[<64;10;5M")).toBe(false); // wheel
    expect(isMotionReport("x")).toBe(false);
  });

  it("chunks under the frame cap without splitting a surrogate pair", () => {
    expect(chunkTerminalInput("")).toEqual([]);
    expect(chunkTerminalInput("abc")).toEqual(["abc"]);
    const big = "a".repeat(TERMINAL_INPUT_CHUNK_CHARS + 10);
    expect(chunkTerminalInput(big).map((c) => c.length)).toEqual([TERMINAL_INPUT_CHUNK_CHARS, 10]);
    const emoji = "ab😀cd"; // 😀 is two UTF-16 units at index 2-3
    const parts = chunkTerminalInput(emoji, 3);
    expect(parts.join("")).toBe(emoji);
    expect(parts[0]).toBe("ab");
    for (const part of parts) expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  it("builds SGR wheel reports", () => {
    expect(wheelReports(2, 3, 4)).toBe("\x1b[<65;3;4M\x1b[<65;3;4M");
    expect(wheelReports(-1, 1, 1)).toBe("\x1b[<64;1;1M");
    expect(wheelReports(0, 1, 1)).toBe("");
  });

  it("detects a coarse primary pointer and fails safe to desktop", () => {
    expect(isCoarsePointer({ matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" }) } as never)).toBe(true);
    expect(isCoarsePointer({ matchMedia: () => ({ matches: false }) } as never)).toBe(false);
    expect(isCoarsePointer({ matchMedia: () => { throw new Error("no"); } } as never)).toBe(false);
    expect(isCoarsePointer(undefined)).toBe(false);
  });
});

describe("createTerminalInputSender", () => {
  function harness() {
    const sent: string[] = [];
    let frame: (() => void) | null = null;
    const sender = createTerminalInputSender(
      (d) => sent.push(d),
      (cb) => { frame = cb; return 1; },
      () => { frame = null; },
    );
    return { sent, sender, runFrame: () => { const f = frame; frame = null; f?.(); } };
  }

  it("coalesces pointer motion to the latest report per frame", () => {
    const { sent, sender, runFrame } = harness();
    sender.push("\x1b[<35;1;1M");
    sender.push("\x1b[<35;2;1M");
    sender.push("\x1b[<35;3;1M");
    expect(sent).toEqual([]);
    runFrame();
    expect(sent).toEqual(["\x1b[<35;3;1M"]);
  });

  it("flushes pending motion before any other input so order is kept", () => {
    const { sent, sender } = harness();
    sender.push("\x1b[<35;9;9M");
    sender.push("\x1b[<0;9;9M");
    expect(sent).toEqual(["\x1b[<35;9;9M", "\x1b[<0;9;9M"]);
  });

  it("drops focus reports and empty input; chunks large pastes", () => {
    const { sent, sender } = harness();
    sender.push("\x1b[I");
    sender.push("");
    sender.push("z".repeat(TERMINAL_INPUT_CHUNK_CHARS * 2 + 1));
    expect(sent.map((s) => s.length)).toEqual([TERMINAL_INPUT_CHUNK_CHARS, TERMINAL_INPUT_CHUNK_CHARS, 1]);
  });

  it("sends nothing after dispose", () => {
    const send = vi.fn();
    const sender = createTerminalInputSender(send, () => 1, () => {});
    sender.push("\x1b[<35;1;1M");
    sender.dispose();
    sender.flush();
    sender.push("a");
    expect(send).not.toHaveBeenCalled();
  });
});
