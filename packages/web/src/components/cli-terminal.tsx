import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { usePageVisibility } from "../hooks/use-page-visibility";
import { takeTerminalFocus } from "../lib/terminal-focus";
import { dlog } from "../lib/debug-log";
import { nextReconnectDelay } from "../lib/ws-backoff";
import { copyText, openExternal } from "../platform";
import {
  chunkTerminalInput,
  createTerminalInputSender,
  isCoarsePointer,
  suppressTerminalQueryReplies,
  trackSgrMouseMode,
  wheelReports,
} from "../lib/terminal-input";
import {
  GATEWAY_SOCKET_CLOSED,
  GATEWAY_SOCKET_CLOSING,
  GATEWAY_SOCKET_OPEN,
  gatewayTransport,
  type GatewaySocketConnection,
} from "../lib/gateway-transport";

/**
 * Theme-aware xterm color palettes. The app exposes exactly two visual themes
 * via `data-theme` on <html> ("dark" / "light"; "system" resolves through the
 * prefers-color-scheme media query). These ITheme palettes mirror the Ledger
 * design tokens (warm charcoal / warm paper) with a tasteful warm ANSI 16-color
 * set so the interactive `claude` TUI reads correctly in both themes.
 */
const XTERM_THEME_DARK: ITheme = {
  background: "#0F1719",
  foreground: "#E2ECEB",
  cursor: "#3DBFB2",
  cursorAccent: "#0F1719",
  selectionBackground: "rgba(61,191,178,0.30)",
  black: "#0F1719",
  red: "#E0675A",
  green: "#7DBE6A",
  yellow: "#E0A33C",
  blue: "#5B9BD5",
  magenta: "#B98AD6",
  cyan: "#6FBFB0",
  white: "#E2ECEB",
  brightBlack: "#5C564A",
  brightRed: "#EC8479",
  brightGreen: "#95D183",
  brightYellow: "#EDB85E",
  brightBlue: "#7BB1E2",
  brightMagenta: "#CBA3E4",
  brightCyan: "#8AD2C4",
  brightWhite: "#F4F1E8",
};

const XTERM_THEME_LIGHT: ITheme = {
  background: "#EEF3F3",
  foreground: "#14211F",
  cursor: "#0A6763",
  cursorAccent: "#EEF3F3",
  selectionBackground: "rgba(10,103,99,0.25)",
  black: "#14211F",
  red: "#B23B33",
  green: "#5C7A4A",
  yellow: "#B07A1A",
  blue: "#2D6CB5",
  magenta: "#7A5A9E",
  cyan: "#2E7D74",
  white: "#14211F",
  brightBlack: "#6B6457",
  brightRed: "#C45248",
  brightGreen: "#6E8E5A",
  brightYellow: "#C68F2A",
  brightBlue: "#3F7DC4",
  brightMagenta: "#8E6CB0",
  brightCyan: "#3C8E84",
  brightWhite: "#0F1719",
};

/** Resolve the active app theme to its xterm palette. "system" → media query. */
function resolveXtermTheme(): ITheme {
  if (typeof document === "undefined") return XTERM_THEME_DARK;
  const attr = document.documentElement.getAttribute("data-theme");
  // ThemeProvider writes a concrete "dark"/"light" onto <html> even for
  // "system", but guard for "system"/absent by resolving the media query.
  let mode = attr;
  if (!mode || mode === "system") {
    mode =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  return mode === "light" ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
}

/** Read the app mono font from CSS so the terminal matches the rest of the UI. */
function resolveXtermFont(): string {
  if (typeof document === "undefined") return '"IBM Plex Mono", monospace';
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-code")
    .trim();
  return v || '"IBM Plex Mono", monospace';
}

/** One wheel notch (~100px in Chromium) moves ~2.8 lines at xterm's default
 *  sensitivity: half the speed of the page around it, which is what made long
 *  claude scrollback feel stuck. 2 puts a notch at ~5.5 lines, the same
 *  distance a notch scrolls the chat view. Alt+wheel stays xterm's fast scroll. */
const WHEEL_SCROLL_SENSITIVITY = 2;

/** Open a link from the terminal: http(s) only, through the platform layer so
 *  the desktop app opens it in the system browser. */
function openTerminalLink(_event: MouseEvent, uri: string): void {
  let protocol: string;
  try { protocol = new URL(uri).protocol; } catch { return; }
  if (protocol === "http:" || protocol === "https:") void openExternal(uri);
}

/** OSC 8 hyperlinks. xterm's default handler asks via window.confirm, which
 *  blocks the page. */
const OSC8_LINK_HANDLER = { activate: openTerminalLink };

/**
 * Live xterm.js view onto a session's interactive PTY, served over /ws/pty/:sessionId.
 *
 * Two input paths, deliberately separate:
 *   - The parent's <ChatInput /> (a flex sibling rendered by chat-pane) is an ordinary Jinn
 *     turn: it POSTs to /api/sessions/:id/message with `mode: "interactive"`, and the engine
 *     injects the prompt into this same PTY, so it lands in the transcript and appears here.
 *   - On a desktop (fine pointer) the terminal itself is a real terminal: click it
 *     and keystrokes, pastes and mouse reports go straight to the PTY as `input` frames.
 *     That is the operator driving the TUI, not a Jinn turn. xterm's automatic replies to
 *     terminal queries are suppressed so only what the operator did reaches the PTY.
 *   - Touch devices keep the display-only terminal (`disableStdin`): composer + keybar, with
 *     swipe-to-scroll. A swipe over a full-screen TUI that tracks the mouse (opencode)
 *     becomes wheel reports, because that TUI has no scrollback for xterm to scroll.
 *
 * Resilience: the socket reconnects with backoff on close/error WITHOUT disposing the
 * xterm Terminal. The daemon sends an authoritative reset + serialized snapshot before
 * ordered live deltas (see pty-ws.ts), while the old screen remains visible underneath
 * the restoring state. Returning after sleep/background also recovers a half-open socket.
 * Only a sessionId change (or unmount) tears the Terminal down.
 */
export interface CliTerminalHandle {
  sendKey(data: string): void;
  /** Raw input, as if typed: the touch input bar of an operator terminal. */
  sendInput(data: string): void;
}

type TerminalRecoveryState =
  | { status: "restoring" }
  | { status: "ready" }
  // `recoverable: false` means the terminal itself is gone for good (its
  // session was deleted) — restarting cannot help, so the view
  // drops out of the live-terminal contract instead of offering to.
  | { status: "error"; message: string; recoverable: boolean };

/** The gap above the terminal's first row. A host whose chrome floats over the
 *  pane sets `--cli-terminal-top-inset` to clear it (the chat page does, under
 *  its floating header — JIN-2); anywhere else it is the plain 1rem. Every
 *  overlay pinned to the top edge is placed against it too, so none of them
 *  slips back under that chrome. */
const TOP_INSET = "var(--cli-terminal-top-inset, 1rem)";

interface CliTerminalProps {
  sessionId: string;
  /** An operator shell: the focused viewer answers terminal queries. */
  shell?: boolean;
}

export const CliTerminal = forwardRef<CliTerminalHandle, CliTerminalProps>(function CliTerminal({ sessionId, shell = false }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<GatewaySocketConnection | null>(null);
  // Lets the visibility effect (a separate effect) recover a dead socket without
  // leaking the per-session connect closure out of the main effect.
  const reconnectRef = useRef<(() => void) | null>(null);
  const visible = usePageVisibility();
  const [terminalState, setTerminalState] = useState<TerminalRecoveryState>({ status: "restoring" });
  const [reconnecting, setReconnecting] = useState(false);
  // Fixed per mount: a pointer-type change mid-session (docking a tablet) takes
  // effect on the next mount rather than re-plumbing a live terminal.
  const [interactive] = useState(() => !isCoarsePointer());
  const [focused, setFocused] = useState(false);

  const restartTerminal = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== GATEWAY_SOCKET_OPEN) return;
    setTerminalState({ status: "restoring" });
    ws.send(JSON.stringify({ type: "restart" }));
  };

  useImperativeHandle(ref, () => ({
    sendKey(data: string) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== GATEWAY_SOCKET_OPEN) return;
      ws.send(JSON.stringify({ type: "key", data }));
    },
    sendInput(data: string) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== GATEWAY_SOCKET_OPEN) return;
      for (const chunk of chunkTerminalInput(data)) ws.send(JSON.stringify({ type: "input", data: chunk }));
    },
  }), []);

  useEffect(() => {
    // Defensive guard — parent already gates rendering on sessionId, but if a falsy
    // value ever slips through, do nothing rather than open /ws/pty/null.
    if (!sessionId) return;
    if (!containerRef.current) return;
    setTerminalState({ status: "restoring" });

    const displayOnlyOptions = {
      convertEol: true,
      fontSize: 13,
      fontFamily: resolveXtermFont(),
      theme: resolveXtermTheme(),
      scrollback: 5000,
      scrollOnUserInput: true,
      // Display-only (touch devices): input flows through the sibling
      // ChatInput, never via xterm. Disabling stdin drops xterm's hidden helper
      // textarea + its pointer/touch handlers, which were absorbing one-finger
      // swipes on iOS before they could reach .xterm-viewport's scrollable area.
      disableStdin: true,
    };
    const term = new Terminal(interactive
      ? {
          ...displayOnlyOptions,
          disableStdin: false,
          scrollSensitivity: WHEEL_SCROLL_SENSITIVITY,
          linkHandler: OSC8_LINK_HANDLER,
        }
      : displayOnlyOptions);
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Registered before open() so no query in the first snapshot slips through.
    // A shell's programs expect answers, so the one viewer being typed into
    // replies: its window has focus AND its terminal does. A window in the
    // background keeps activeElement, which is why hasFocus() is checked too.
    const parserHooks = interactive
      ? suppressTerminalQueryReplies(term, shell ? () => !(document.hasFocus() && document.activeElement === term.textarea) : undefined)
      : [];
    const sgrMouse = trackSgrMouseMode(term);
    term.open(containerRef.current);
    // A shell just opened from the host menu asks its startup queries before
    // anyone clicks: take the keyboard at once, as opening a terminal app does.
    if (shell && interactive && takeTerminalFocus(sessionId)) term.focus();

    const sendInput = (data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== GATEWAY_SOCKET_OPEN) return;
      ws.send(JSON.stringify({ type: "input", data }));
    };
    const inputSender = createTerminalInputSender(sendInput);
    const inputHooks: Array<{ dispose(): void }> = [];
    if (interactive) {
      term.loadAddon(new WebLinksAddon(openTerminalLink));
      inputHooks.push(term.onData((data) => inputSender.push(data)));
      // Legacy (non-SGR) mouse encodings arrive as one char per byte. Only the
      // ASCII range survives the JSON/UTF-8 hop unchanged; the TUIs we host all
      // use SGR (?1006), so anything wider is dropped rather than mangled.
      inputHooks.push(term.onBinary((data) => { if (/^[\x00-\x7f]*$/.test(data)) inputSender.push(data); }));
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        // Ctrl/Cmd+C with a selection copies it (as every terminal does) rather
        // than sending ^C to the TUI. Without a selection it is still ^C.
        if (mod && !event.altKey && key === "c" && term.hasSelection()) {
          void copyText(term.getSelection());
          return false;
        }
        // Ctrl+Shift+C / Ctrl+Shift+V: the Linux terminal copy/paste chords.
        // Returning false leaves the browser's default action (a paste event
        // xterm handles itself) in place.
        if (event.ctrlKey && event.shiftKey && (key === "c" || key === "v")) {
          if (key === "c" && term.hasSelection()) void copyText(term.getSelection());
          return false;
        }
        // Shift+PageUp/PageDown scroll xterm's own scrollback; plain PageUp/Down
        // still reach the TUI.
        if (event.shiftKey && !mod && (event.key === "PageUp" || event.key === "PageDown")) {
          term.scrollPages(event.key === "PageUp" ? -1 : 1);
          return false;
        }
        return true;
      });
      const textarea = term.textarea;
      if (textarea) {
        const onFocusIn = () => setFocused(true);
        const onFocusOut = () => setFocused(false);
        textarea.addEventListener("focus", onFocusIn);
        textarea.addEventListener("blur", onFocusOut);
        inputHooks.push({ dispose: () => {
          textarea.removeEventListener("focus", onFocusIn);
          textarea.removeEventListener("blur", onFocusOut);
        } });
      }
    }
    // NOTE: deliberately NOT calling fit.fit() synchronously here. On direct
    // CLI mount the container hasn't laid out yet (width 0), so a sync fit
    // would lock xterm to ~0 cols and the backend PTY would render claude's
    // TUI at that bogus width. scheduleFit() below (run in rAF + on first
    // ResizeObserver tick) fits at real dimensions and emits the resize then.

    // iOS Safari renders certain monochrome TUI glyphs (⏺ U+23FA, ⏵ U+23F5, etc.)
    // as colour emoji when the font lacks a text glyph. Appending U+FE0E (text
    // presentation selector) forces the text form. font-variant-emoji works only on
    // Safari 17.4+; this byte-stream fix works everywhere. Decode → patch → write
    // is safe because xterm.write accepts strings and U+FE0E is zero-width.
    const TEXT_PRESENT_GLYPHS = /[⏰-⏿■-◿☀-⛿]/g;
    let decoder = new TextDecoder("utf-8");
    const forceTextGlyphs = (s: string) => s.replace(TEXT_PRESENT_GLYPHS, (m) => m + "︎");

    const onWsMessage = (e: MessageEvent) => {
      // Text frames are structured lifecycle controls. Binary frames are the
      // only live PTY delta path; arbitrary control bytes never imply readiness.
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === "reset") {
            decoder.decode();
            decoder = new TextDecoder("utf-8");
            term.reset();
            setTerminalState({ status: "restoring" });
            return;
          }
          if (msg?.type === "snapshot" && typeof msg.snapshot?.data === "string") {
            const cols = Number(msg.snapshot.cols);
            const rows = Number(msg.snapshot.rows);
            if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
              try { term.resize(Math.floor(cols), Math.floor(rows)); } catch { /* disposed */ }
            }
            term.write(forceTextGlyphs(msg.snapshot.data), scheduleFit);
            return;
          }
          if (msg?.type === "ready") {
            setTerminalState({ status: "ready" });
            return;
          }
          if (msg?.type === "restoring") {
            setTerminalState({ status: "restoring" });
            return;
          }
          if (msg?.type === "error" && typeof msg.message === "string") {
            const recoverable = msg.recoverable !== false;
            setTerminalState({ status: "error", message: msg.message, recoverable });
            if (!recoverable) {
              // The terminal is gone for good (its session was deleted,
              // the server closes this socket right behind this
              // message, and there is nothing to reconnect to — drop out of
              // the retry loop instead of chasing a session that no longer
              // exists.
              closed = true;
              setReconnecting(false);
              if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            }
            return;
          }
          if (msg?.type === "exited") {
            const code = typeof msg.exitCode === "number" ? msg.exitCode : "unknown";
            setTerminalState({ status: "error", message: `Terminal exited with code ${code}.`, recoverable: true });
            return;
          }
        } catch {
          // Control frames must be valid JSON; never paint them as terminal data.
        }
      } else {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        term.write(forceTextGlyphs(decoder.decode(bytes, { stream: true })));
      }
    };

    // --- Reconnect machinery -------------------------------------------------
    // The Terminal instance outlives individual sockets; only the WebSocket is
    // recreated on a drop. The daemon restores an authoritative terminal
    // snapshot before releasing ordered live deltas on every connection.
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (isReconnect: boolean) => {
      if (closed) return;
      const ws = gatewayTransport().openSocket(`/ws/pty/${encodeURIComponent(sessionId)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = onWsMessage;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        attempt = 0;
        setReconnecting(false);
        dlog("xterm", `ws.onopen${isReconnect ? " (reconnect)" : ""} wrapper=${containerRef.current?.getBoundingClientRect().width.toFixed(0) ?? "?"}x${containerRef.current?.getBoundingClientRect().height.toFixed(0) ?? "?"}`);
        // Keep the last good screen beneath the restoring state until the server
        // sends its authoritative reset/snapshot. This avoids a blank canvas if
        // reconnect succeeds but PTY resume stalls.
        if (isReconnect) {
          setTerminalState({ status: "restoring" });
        }
        // Initial viewing report — backend ref-counts viewers and uses this to
        // keep the PTY warm (or auto-respawn on return if it was reaped).
        ws.send(JSON.stringify({ type: "viewing", viewing: document.visibilityState === "visible" }));
        // Defer the resize message until after fit runs at real dimensions —
        // see scheduleFit below.
        scheduleFit();
      };

      ws.onclose = (ev) => {
        dlog("xterm", `ws.onclose code=${ev.code} reason=${ev.reason || "—"}`);
        if (wsRef.current !== ws) return; // superseded by a manual reconnect
        scheduleReconnect();
      };
      ws.onerror = () => {
        dlog("xterm", "ws.onerror");
        // Let onclose drive the reconnect; closing is idempotent.
        try { ws.close(); } catch { /* ignore */ }
      };
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== null) return;
      setReconnecting(true);
      const delay = nextReconnectDelay(attempt++);
      dlog("xterm", `reconnect in ${delay}ms (attempt ${attempt})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(true);
      }, delay);
    };

    // Recover a dead/half-open socket immediately (used by the visibility effect
    // on return-to-foreground). No-op if the socket is already open.
    const reconnectNow = () => {
      if (closed) return;
      const cur = wsRef.current;
      if (cur && cur.readyState === GATEWAY_SOCKET_OPEN) return;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      attempt = 0;
      if (cur && cur.readyState !== GATEWAY_SOCKET_CLOSED) {
        // Detach so the stale socket's onclose can't schedule a duplicate reconnect.
        cur.onclose = null;
        cur.onerror = null;
        try { cur.close(); } catch { /* ignore */ }
      }
      connect(true);
    };
    reconnectRef.current = reconnectNow;

    // Coalesce a burst of `resize` events (window drag, mobile rotation,
    // devtools open) into one fit + one WS frame per animation frame. Without
    // this, fit.fit() and a WS resize message fire per pixel during a drag.
    // The cols>0/rows>0 guard prevents broadcasting a (0,0) geometry to the
    // PTY when this runs before the wrapper has laid out.
    let raf: number | null = null;
    let fitCount = 0;
    const scheduleFit = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        const rect = containerRef.current?.getBoundingClientRect();
        // Don't fit/spawn when the wrapper hasn't laid out yet — fit() would
        // compute cols=11 from xterm's 0px canvas and the backend would spawn
        // claude at cols=11, locking the TUI text body into a squished column
        // even after a later resize. Wait for ResizeObserver to fire with real
        // dimensions instead.
        if (!rect || rect.width < 50 || rect.height < 30) {
          dlog("xterm", `fit-skipped wrapper=${rect?.width.toFixed(0) ?? "?"}x${rect?.height.toFixed(0) ?? "?"}`);
          return;
        }
        try { fit.fit(); } catch { /* container not yet sized */ }
        fitCount++;
        dlog("xterm", `fit#${fitCount} wrapper=${rect.width.toFixed(0)}x${rect.height.toFixed(0)} cols=${term.cols} rows=${term.rows}`);
        const ws = wsRef.current;
        if (term.cols > 0 && term.rows > 0 && ws && ws.readyState === GATEWAY_SOCKET_OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          dlog("xterm", `ws.send resize cols=${term.cols} rows=${term.rows}`);
        }
      });
    };
    window.addEventListener("resize", scheduleFit);

    // ChatInput sits beside us as a flex sibling and grows when the user attaches
    // files. Without this observer the xterm container height shrinks but xterm
    // keeps its old row count — text gets clipped at the bottom.
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) dlog("xterm", `ResizeObserver wrapper=${e.contentRect.width.toFixed(0)}x${e.contentRect.height.toFixed(0)}`);
      scheduleFit();
    });
    ro.observe(containerRef.current);

    // Touch-to-scroll via xterm's own scrollLines() API. iOS Safari has a known
    // quirk: assigning .scrollTop on an absolutely-positioned overflow:scroll
    // element (which is exactly what .xterm-viewport is) updates the property
    // but doesn't visually scroll. xterm's term.scrollLines() goes through its
    // render pipeline instead and works on every browser. Each ~17px of swipe
    // delta = 1 buffer line; we diff against the last sent count so a single
    // long drag accumulates smoothly without per-frame compounding.
    const wrapper = containerRef.current;
    const PX_PER_LINE = 17;
    let touchStartY = 0;
    let linesSent = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      touchStartY = e.touches[0].clientY;
      linesSent = 0;
      dlog("touch", `start Y=${touchStartY.toFixed(0)}`);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const totalDelta = touchStartY - e.touches[0].clientY;
      const targetLines = Math.trunc(totalDelta / PX_PER_LINE);
      const linesToScroll = targetLines - linesSent;
      if (linesToScroll === 0) return;
      linesSent = targetLines;
      // A full-screen TUI that tracks the mouse (opencode) runs in the
      // alternate buffer, which has no scrollback for scrollLines() to move:
      // it scrolls itself, on wheel reports. Send the swipe as those. Only when
      // the program chose SGR encoding (?1006), the one we can write safely.
      if (term.buffer.active.type === "alternate" && term.modes.mouseTrackingMode !== "none" && sgrMouse.enabled) {
        const screen = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
        const touch = e.touches[0];
        const col = screen && screen.width > 0
          ? Math.min(term.cols, Math.max(1, Math.floor((touch.clientX - screen.left) / (screen.width / term.cols)) + 1))
          : 1;
        const row = screen && screen.height > 0
          ? Math.min(term.rows, Math.max(1, Math.floor((touch.clientY - screen.top) / (screen.height / term.rows)) + 1))
          : 1;
        sendInput(wheelReports(linesToScroll, col, row));
        return;
      }
      // term.scrollLines: positive = scroll down (toward newer/bottom).
      // Swipe up (finger up, delta>0) → see newer → scroll down → positive.
      term.scrollLines(linesToScroll);
    };
    wrapper.addEventListener("touchstart", onTouchStart, { passive: true });
    wrapper.addEventListener("touchmove", onTouchMove, { passive: true });

    // Live re-theme: when the app theme flips (data-theme attribute on <html>,
    // or the OS color scheme while in "system" mode) re-apply the matching
    // xterm palette + mono font so an already-open terminal updates instantly.
    // `disposed` guards against the rare race where a pending observer/media
    // callback fires after term.dispose() during teardown.
    let disposed = false;
    const applyTheme = () => {
      if (disposed) return;
      try {
        term.options.theme = resolveXtermTheme();
        term.options.fontFamily = resolveXtermFont();
      } catch {
        /* term disposed mid-flight */
      }
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const colorSchemeMq = window.matchMedia("(prefers-color-scheme: dark)");
    colorSchemeMq.addEventListener("change", applyTheme);

    // Open the first socket + kick off the initial fit on the next frame so
    // layout has settled.
    connect(false);
    scheduleFit();

    return () => {
      disposed = true;
      closed = true;
      inputSender.dispose();
      for (const hook of [...inputHooks, ...parserHooks, ...sgrMouse.disposables]) hook.dispose();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectRef.current = null;
      themeObserver.disconnect();
      colorSchemeMq.removeEventListener("change", applyTheme);
      window.removeEventListener("resize", scheduleFit);
      ro.disconnect();
      wrapper.removeEventListener("touchstart", onTouchStart);
      wrapper.removeEventListener("touchmove", onTouchMove);
      if (raf !== null) cancelAnimationFrame(raf);
      const ws = wsRef.current;
      if (ws) {
        // Detach handlers so the close below can't schedule a reconnect.
        ws.onclose = null;
        ws.onerror = null;
        // Explicit viewing:false before close so the backend decrements promptly
        // (close handler also decrements as a safety net, but this is cleaner).
        if (ws.readyState === GATEWAY_SOCKET_OPEN) {
          try { ws.send(JSON.stringify({ type: "viewing", viewing: false })); } catch { /* ignore */ }
        }
        ws.close();
      }
      wsRef.current = null;
      term.dispose();
    };
  }, [sessionId, interactive, shell]);

  // Page Visibility — emit on backgrounding/foregrounding so the backend can
  // start the 10-min grace timer (hidden) or trigger auto-resume respawn (visible).
  // On return-to-visible we ALSO recover a socket that went half-open while the tab
  // was backgrounded (mobile sleep/wake): if it isn't OPEN, reconnect; otherwise
  // re-report viewing + dispatch a synthetic resize to respawn the PTY at the
  // correct geometry (pty-ws spawns lazily on first resize). The scheduleFit hook
  // lives inside the main effect; the synthetic resize event triggers it without
  // leaking a ref out of that effect.
  useEffect(() => {
    const ws = wsRef.current;
    if (visible) {
      // Only force a reconnect for a socket that has actually failed
      // (CLOSING/CLOSED). A CONNECTING socket — e.g. the initial one on mount —
      // is mid-handshake and must be left alone; its onopen will report viewing.
      if (!ws || ws.readyState === GATEWAY_SOCKET_CLOSING || ws.readyState === GATEWAY_SOCKET_CLOSED) {
        reconnectRef.current?.();
        return;
      }
      if (ws.readyState === GATEWAY_SOCKET_OPEN) {
        try { ws.send(JSON.stringify({ type: "viewing", viewing: true })); } catch { /* ignore */ }
        window.dispatchEvent(new Event("resize"));
      }
    } else if (ws && ws.readyState === GATEWAY_SOCKET_OPEN) {
      try { ws.send(JSON.stringify({ type: "viewing", viewing: false })); } catch { /* ignore */ }
    }
  }, [visible]);

  if (!sessionId) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-code)",
          fontSize: 13,
          padding: "1rem",
          textAlign: "center",
        }}
      >
        Send your first message to start the interactive session.
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        width: "100%",
        overflow: "hidden",
        background: "var(--bg)",
        // The inset is padding on this wrapper, never on the xterm container:
        // fit() measures the container, so its rows stay the visible ones.
        paddingTop: TOP_INSET,
        boxSizing: "border-box",
      }}
      data-cli-terminal-root
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        data-cli-terminal={interactive ? "interactive" : "display"}
        data-focused={interactive && focused ? "true" : undefined}
        style={{ height: "100%", width: "100%", overflow: "hidden", background: "var(--bg)" }}
      />
      {interactive && (
        // Where keystrokes go must be visible: the composer and the terminal
        // both take typing, and they mean different things. An overlay, because
        // xterm's own layers paint over anything drawn on its container.
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: `calc(${TOP_INSET} - 4px) 0 0 0`,
            borderRadius: 6,
            boxShadow: `inset 0 0 0 1px ${focused ? "var(--accent)" : "transparent"}`,
            transition: "box-shadow 120ms ease-out",
            pointerEvents: "none",
          }}
        />
      )}
      {reconnecting && (
        <div
          style={{
            position: "absolute",
            top: `calc(${TOP_INSET} - 0.5rem)`,
            right: "0.75rem",
            padding: "0.15rem 0.5rem",
            borderRadius: 6,
            background: "var(--bg-secondary, rgba(0,0,0,0.35))",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-code)",
            fontSize: 11,
            pointerEvents: "none",
            opacity: 0.85,
          }}
        >
          reconnecting…
        </div>
      )}
      {terminalState.status === "restoring" && (
        <div
          style={{
            position: "absolute",
            top: `calc(${TOP_INSET} - 1rem)`,
            left: 0,
            right: 0,
            padding: "1rem",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-code)",
            fontSize: 12,
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          Restoring terminal…
        </div>
      )}
      {terminalState.status === "error" && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: `calc(${TOP_INSET} - 0.25rem)`,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "0.65rem",
            maxWidth: "calc(100% - 1.5rem)",
            padding: "0.5rem 0.6rem 0.5rem 0.8rem",
            borderRadius: 10,
            background: "var(--bg-secondary, rgba(20,19,15,0.92))",
            boxShadow: "0 8px 24px rgba(0,0,0,0.16), 0 1px 2px rgba(0,0,0,0.12)",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-code)",
            fontSize: 12,
            textWrap: "pretty",
            zIndex: 2,
          }}
        >
          <span>{terminalState.message}</span>
          {terminalState.recoverable && (
            <button
              type="button"
              onClick={restartTerminal}
              className="min-h-10 shrink-0 rounded-lg px-3 transition-transform active:scale-[0.96]"
              style={{
                background: "var(--accent)",
                color: "var(--accent-foreground)",
                fontFamily: "var(--font-code)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Restart terminal
            </button>
          )}
        </div>
      )}
    </div>
  );
});
