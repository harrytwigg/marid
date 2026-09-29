import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewayTransport, installGatewayTransport } from "../../lib/gateway-transport";

type FakeTerminal = {
  writes: string[];
  screen: string;
  resets: number;
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  addons: unknown[];
  csiHandlers: Array<{ id: Record<string, string>; cb: (params: (number | number[])[]) => boolean }>;
  oscHandlers: number[];
  dcsHandlers: Array<Record<string, string>>;
  dataListeners: Array<(data: string) => void>;
  binaryListeners: Array<(data: string) => void>;
  keyHandler?: (event: KeyboardEvent) => boolean;
  selection: string;
  scrolledLines: number[];
  scrolledPages: number[];
  buffer: { active: { type: string } };
  modes: { mouseTrackingMode: string };
  textarea: HTMLTextAreaElement;
  element: HTMLDivElement;
};

const xtermState = vi.hoisted(() => ({
  instances: [] as FakeTerminal[],
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    writes: string[] = [];
    screen = "";
    resets = 0;
    cols = 90;
    rows = 30;
    options: Record<string, unknown>;
    addons: unknown[] = [];
    csiHandlers: FakeTerminal["csiHandlers"] = [];
    oscHandlers: number[] = [];
    dcsHandlers: Array<Record<string, string>> = [];
    dataListeners: Array<(data: string) => void> = [];
    binaryListeners: Array<(data: string) => void> = [];
    keyHandler?: (event: KeyboardEvent) => boolean;
    selection = "";
    scrolledLines: number[] = [];
    scrolledPages: number[] = [];
    buffer = { active: { type: "normal" } };
    modes = { mouseTrackingMode: "none" };
    textarea = document.createElement("textarea");
    element = document.createElement("div");
    parser = {
      registerCsiHandler: (id: Record<string, string>, cb: (params: (number | number[])[]) => boolean) => {
        this.csiHandlers.push({ id, cb });
        return { dispose() {} };
      },
      registerOscHandler: (id: number) => { this.oscHandlers.push(id); return { dispose() {} }; },
      registerDcsHandler: (id: Record<string, string>) => { this.dcsHandlers.push(id); return { dispose() {} }; },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermState.instances.push(this as unknown as FakeTerminal);
    }
    loadAddon(addon: unknown) { this.addons.push(addon); }
    open() {}
    onData(listener: (data: string) => void) { this.dataListeners.push(listener); return { dispose() {} }; }
    onBinary(listener: (data: string) => void) { this.binaryListeners.push(listener); return { dispose() {} }; }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler; }
    hasSelection() { return this.selection.length > 0; }
    getSelection() { return this.selection; }
    scrollPages(n: number) { this.scrolledPages.push(n); }
    write(data: string, callback?: () => void) {
      this.writes.push(data);
      this.screen += data;
      callback?.();
    }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    reset() { this.resets += 1; this.screen = ""; }
    scrollLines(n: number) { this.scrolledLines.push(n); }
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class { webLinks = true; constructor(public handler?: (e: MouseEvent, uri: string) => void) {} },
}));
const platformCalls = vi.hoisted(() => ({ copied: [] as string[], opened: [] as string[] }));
vi.mock("../../platform", () => ({
  copyText: (text: string) => { platformCalls.copied.push(text); return Promise.resolve({ ok: true }); },
  openExternal: (url: string) => { platformCalls.opened.push(url); return Promise.resolve({ ok: true }); },
}));

import { CliTerminal } from "../cli-terminal";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "test" } as CloseEvent);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  control(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  binary(data: string): void {
    const bytes = new TextEncoder().encode(data);
    this.onmessage?.({ data: bytes.buffer } as MessageEvent);
  }
}

const live = () => FakeWebSocket.instances;

/** jsdom has no matchMedia. `coarse` answers only the pointer query, so the
 *  theme's prefers-color-scheme lookups behave the same either way. */
function setPointer(kind: "fine" | "coarse"): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: kind === "coarse" && query === "(pointer: coarse)",
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

function sentFrames(ws: FakeWebSocket): any[] {
  return ws.sent.map((frame) => JSON.parse(frame));
}

function inputFrames(ws: FakeWebSocket): string[] {
  return sentFrames(ws).filter((frame) => frame.type === "input").map((frame) => frame.data);
}

function openReady(): FakeWebSocket {
  const ws = live()[0]!;
  act(() => ws.open());
  act(() => {
    ws.control({ type: "reset" });
    ws.control({ type: "snapshot", snapshot: { data: "screen", cols: 90, rows: 30, visible: true } });
    ws.control({ type: "ready" });
  });
  return ws;
}
const terminal = () => xtermState.instances[0]!;
let restoreTransport: (() => void) | null = null;

describe("CliTerminal recovery protocol", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    xtermState.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
      origin: "https://qa-a.example:7779",
      request: vi.fn(),
      navigate: vi.fn(),
    }));
    setPointer("fine");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 900,
      height: 500,
      top: 0,
      left: 0,
      right: 900,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    restoreTransport?.();
    restoreTransport = null;
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps restoring visible for clear/cursor-only deltas and hides it only after snapshot + ready", () => {
    render(<CliTerminal sessionId="session-1" />);
    expect(live()[0]?.url).toBe("wss://qa-a.example:7779/ws/pty/session-1");
    act(() => live()[0]!.open());
    expect(screen.getByText(/Restoring terminal/i)).toBeTruthy();

    act(() => live()[0]!.binary("\u001b[2J\u001b[H\u001b[?25l"));
    expect(screen.getByText(/Restoring terminal/i)).toBeTruthy();

    act(() => {
      live()[0]!.control({ type: "reset" });
      live()[0]!.control({
        type: "snapshot",
        snapshot: { data: "authoritative screen", cols: 90, rows: 30, visible: true },
      });
      live()[0]!.control({ type: "ready" });
    });
    expect(terminal().screen).toContain("authoritative screen");
    expect(screen.queryByText(/Restoring terminal/i)).toBeNull();
  });

  it("applies reconnect snapshots authoritatively without duplicating old content", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => {
      live()[0]!.control({ type: "reset" });
      live()[0]!.control({ type: "snapshot", snapshot: { data: "screen once", cols: 90, rows: 30, visible: true } });
      live()[0]!.control({ type: "ready" });
    });
    expect(terminal().screen).toBe("screen once");

    act(() => {
      live()[0]!.control({ type: "reset" });
      live()[0]!.control({ type: "snapshot", snapshot: { data: "screen once", cols: 90, rows: 30, visible: true } });
      live()[0]!.control({ type: "ready" });
    });
    expect(terminal().screen).toBe("screen once");
    expect(terminal().resets).toBe(2);
  });

  it("shows resume failures and exposes a working Restart terminal action", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => live()[0]!.control({ type: "error", message: "Terminal did not resume in time.", recoverable: true }));

    expect(screen.getByText("Terminal did not resume in time.")).toBeTruthy();
    const restart = screen.getByRole("button", { name: "Restart terminal" });
    fireEvent.click(restart);
    expect(JSON.parse(live()[0]!.sent.at(-1)!)).toEqual({ type: "restart" });
    expect(screen.getByText(/Restoring terminal/i)).toBeTruthy();
  });

  it("insets the wrapper, not the xterm container, by the host's top inset — overlays too (JIN-2)", () => {
    const INSET = "var(--cli-terminal-top-inset, 1rem)";
    const { container } = render(<CliTerminal sessionId="session-1" />);
    const root = container.querySelector<HTMLElement>("[data-cli-terminal-root]")!;
    const host = container.querySelector<HTMLElement>("[data-cli-terminal]")!;
    // fit() measures the xterm container, so the inset must sit on its parent:
    // padding there would hand xterm rows the chat header then covers.
    expect(host.parentElement).toBe(root);
    expect(root.style.paddingTop).toBe(INSET);
    expect(host.style.paddingTop).toBe("");
    expect(host.style.height).toBe("100%");

    const focusRing = [...root.children].find((el) => (el as HTMLElement).style.boxShadow) as HTMLElement;
    expect(focusRing.style.inset).toBe(`calc(${INSET} - 4px) 0 0 0`);
    expect(screen.getByText(/Restoring terminal/i).style.top).toBe(`calc(${INSET} - 1rem)`);
    act(() => live()[0]!.open());
    act(() => live()[0]!.control({ type: "error", message: "Terminal did not resume in time.", recoverable: true }));
    expect(screen.getByRole("alert").style.top).toBe(`calc(${INSET} - 0.25rem)`);
  });

  it("keeps an exited terminal visibly recoverable instead of showing a blank canvas", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => live()[0]!.control({ type: "exited", exitCode: 1, signal: 0 }));
    expect(screen.getByText(/Terminal exited with code 1/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
  });

  it("drops the view and stops reconnecting when the terminal's own session was deleted", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => live()[0]!.control({ type: "error", message: "This terminal was deleted.", recoverable: false }));

    // A clear, dead-end notice — not the raw "Not a terminal session." a
    // second tab used to see only on its next resize — and no "Restart"
    // offered, since there is nothing left to restart.
    expect(screen.getByText("This terminal was deleted.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart terminal" })).toBeNull();

    // The server closes this socket right behind the notice; the view must
    // not chase it with a reconnect.
    act(() => live()[0]!.close());
    expect(live()).toHaveLength(1);
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
  });
});

describe("CliTerminal input", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    xtermState.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
      origin: "https://qa-a.example:7779",
      request: vi.fn(),
      navigate: vi.fn(),
    }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}),
    });
  });

  afterEach(() => {
    restoreTransport?.();
    restoreTransport = null;
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("desktop (fine pointer)", () => {
    beforeEach(() => setPointer("fine"));

    it("is a real terminal: stdin on, faster wheel, links, query replies suppressed", () => {
      const { container } = render(<CliTerminal sessionId="session-1" />);
      const term = terminal();
      expect(term.options.disableStdin).toBe(false);
      expect(term.options.scrollSensitivity).toBe(2);
      expect(term.options.linkHandler).toBeTruthy();
      expect(term.addons.some((addon) => (addon as { webLinks?: boolean }).webLinks)).toBe(true);
      // DA1/DA2/DSR/DECRQM/… consumed; OSC colour queries; DECRQSS/XTGETTCAP.
      const csi = term.csiHandlers.map((h) => `${h.id.prefix ?? ""}${h.id.intermediates ?? ""}${h.id.final}`);
      expect(csi).toEqual(expect.arrayContaining(["c", ">c", "n", "?n", "$p", "?$p", ">q", "t"]));
      expect(term.oscHandlers).toEqual(expect.arrayContaining([4, 10, 11, 12]));
      expect(term.dcsHandlers.map((id) => `${id.intermediates}${id.final}`)).toEqual(["$q", "+q"]);
      expect(container.querySelector('[data-cli-terminal="interactive"]')).toBeTruthy();
    });

    it("sends keystrokes, pastes and mouse reports as input frames, never as a Jinn turn", () => {
      render(<CliTerminal sessionId="session-1" />);
      const ws = openReady();
      const term = terminal();
      const emit = (data: string) => act(() => term.dataListeners.forEach((listener) => listener(data)));

      emit("h");
      emit("\r");
      emit("\x1b[200~pasted\x1b[201~");
      emit("\x1b[<64;52;14M");
      emit("\x1b[<0;39;12M");

      expect(inputFrames(ws)).toEqual(["h", "\r", "\x1b[200~pasted\x1b[201~", "\x1b[<64;52;14M", "\x1b[<0;39;12M"]);
      expect(sentFrames(ws).some((frame) => frame.type === "stdin")).toBe(false);
    });

    it("drops focus reports and non-ASCII legacy mouse bytes", () => {
      render(<CliTerminal sessionId="session-1" />);
      const ws = openReady();
      const term = terminal();
      act(() => {
        term.dataListeners.forEach((listener) => { listener("\x1b[I"); listener("\x1b[O"); });
        term.binaryListeners.forEach((listener) => { listener("\x1b[M #!"); listener("\x1b[M \xff\xff"); });
      });
      expect(inputFrames(ws)).toEqual(["\x1b[M #!"]);
    });

    it("does not send input while the socket is not open", () => {
      render(<CliTerminal sessionId="session-1" />);
      const term = terminal();
      act(() => term.dataListeners.forEach((listener) => listener("x")));
      expect(inputFrames(live()[0]!)).toEqual([]);
    });

    it("copies a selection on Ctrl+C instead of interrupting the TUI", () => {
      platformCalls.copied.length = 0;
      render(<CliTerminal sessionId="session-1" />);
      const term = terminal();
      const keydown = (init: KeyboardEventInit) => term.keyHandler!(new KeyboardEvent("keydown", init));

      expect(keydown({ key: "c", ctrlKey: true })).toBe(true); // no selection: ^C goes through
      term.selection = "copied text";
      expect(keydown({ key: "c", ctrlKey: true })).toBe(false);
      expect(platformCalls.copied).toEqual(["copied text"]);
      expect(keydown({ key: "PageUp", shiftKey: true })).toBe(false);
      expect(term.scrolledPages).toEqual([-1]);
      expect(keydown({ key: "PageUp" })).toBe(true); // plain PageUp is the TUI's
    });

    it("opens only http(s) links, through the platform layer", () => {
      platformCalls.opened.length = 0;
      render(<CliTerminal sessionId="session-1" />);
      const term = terminal();
      const osc8 = term.options.linkHandler as { activate(e: MouseEvent, uri: string): void };
      const webLinks = term.addons.find((a) => (a as { webLinks?: boolean }).webLinks) as { handler: (e: MouseEvent, uri: string) => void };
      osc8.activate(new MouseEvent("click"), "https://example.com/a");
      osc8.activate(new MouseEvent("click"), "file:///etc/passwd");
      osc8.activate(new MouseEvent("click"), "javascript:alert(1)");
      webLinks.handler(new MouseEvent("click"), "http://example.com/b");
      expect(platformCalls.opened).toEqual(["https://example.com/a", "http://example.com/b"]);
    });

    it("keeps the keybar on its own key frame", () => {
      const ref = { current: null as { sendKey(data: string): void } | null };
      render(<CliTerminal ref={(handle) => { ref.current = handle; }} sessionId="session-1" />);
      const ws = openReady();
      act(() => ref.current!.sendKey("\x1b"));
      expect(sentFrames(ws).at(-1)).toEqual({ type: "key", data: "\x1b" });
    });

    it("shows where keystrokes go while the terminal has focus", () => {
      const { container } = render(<CliTerminal sessionId="session-1" />);
      const host = container.querySelector('[data-cli-terminal="interactive"]')!;
      expect(host.getAttribute("data-focused")).toBeNull();
      act(() => { terminal().textarea.dispatchEvent(new FocusEvent("focus")); });
      expect(host.getAttribute("data-focused")).toBe("true");
      act(() => { terminal().textarea.dispatchEvent(new FocusEvent("blur")); });
      expect(host.getAttribute("data-focused")).toBeNull();
    });
  });

  describe("touch (coarse pointer) — must not regress", () => {
    beforeEach(() => setPointer("coarse"));

    it("constructs the terminal with exactly the display-only options it always had", () => {
      const { container } = render(<CliTerminal sessionId="session-1" />);
      const term = terminal();
      // Byte-identical to the original constructor call. fontFamily/theme
      // are resolved from CSS and asserted by key only.
      expect(Object.keys(term.options).sort()).toEqual(
        ["convertEol", "disableStdin", "fontFamily", "fontSize", "scrollOnUserInput", "scrollback", "theme"],
      );
      expect(term.options).toMatchObject({
        convertEol: true,
        fontSize: 13,
        scrollback: 5000,
        scrollOnUserInput: true,
        disableStdin: true,
      });
      // No stdin plumbing, no query suppression, no link addon, no key handler.
      expect(term.dataListeners).toHaveLength(0);
      expect(term.binaryListeners).toHaveLength(0);
      expect(term.keyHandler).toBeUndefined();
      expect(term.oscHandlers).toHaveLength(0);
      expect(term.dcsHandlers).toHaveLength(0);
      expect(term.addons.some((addon) => (addon as { webLinks?: boolean }).webLinks)).toBe(false);
      // Only the ?1006 tracker, which never consumes a sequence.
      expect(term.csiHandlers.map((h) => `${h.id.prefix}${h.id.final}`)).toEqual(["?h", "?l"]);
      expect(term.csiHandlers.every((h) => h.cb([1006]) === false)).toBe(true);
      // The helper-textarea pointer-events rule is scoped to this attribute.
      expect(container.querySelector('[data-cli-terminal="display"]')).toBeTruthy();
      expect(container.querySelector("[data-focused]")).toBeNull();
    });

    it("still scrolls xterm's own scrollback on a swipe over a normal-buffer TUI (claude)", () => {
      const { container } = render(<CliTerminal sessionId="session-1" />);
      const ws = openReady();
      const host = container.querySelector('[data-cli-terminal="display"]')!;
      fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchMove(host, { touches: [{ clientX: 100, clientY: 300 - 17 * 3 }] });
      expect(terminal().scrolledLines).toEqual([3]);
      expect(inputFrames(ws)).toEqual([]);
    });

    it("turns a swipe over a mouse-tracking full-screen TUI (opencode) into SGR wheel reports", () => {
      const { container } = render(<CliTerminal sessionId="session-1" />);
      const ws = openReady();
      const term = terminal();
      term.buffer.active.type = "alternate";
      term.modes.mouseTrackingMode = "any";
      term.csiHandlers.find((h) => h.id.final === "h")!.cb([1006]);
      const host = container.querySelector('[data-cli-terminal="display"]')!;
      fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 300 }] });
      // Finger down 2 lines = see older = wheel up (64).
      fireEvent.touchMove(host, { touches: [{ clientX: 100, clientY: 300 + 17 * 2 }] });
      expect(term.scrolledLines).toEqual([]);
      expect(inputFrames(ws)).toEqual(["\x1b[<64;1;1M\x1b[<64;1;1M"]);
    });

    it("leaves the swipe to scrollLines when the TUI did not ask for SGR mouse encoding", () => {
      const { container } = render(<CliTerminal sessionId="session-1" />);
      const ws = openReady();
      const term = terminal();
      term.buffer.active.type = "alternate";
      term.modes.mouseTrackingMode = "any";
      const host = container.querySelector('[data-cli-terminal="display"]')!;
      fireEvent.touchStart(host, { touches: [{ clientX: 100, clientY: 300 }] });
      fireEvent.touchMove(host, { touches: [{ clientX: 100, clientY: 300 - 17 }] });
      expect(term.scrolledLines).toEqual([1]);
      expect(inputFrames(ws)).toEqual([]);
    });
  });
});
