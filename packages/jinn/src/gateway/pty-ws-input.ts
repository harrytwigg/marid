/** The keybar keys a `key` frame may send: Enter, Escape, Tab, Ctrl-C and the arrows. */
export const RAW_KEY_INPUTS = new Set(["\r", "\x1b", "\t", "\x03", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]);

/** Whether a `resize` frame names a usable terminal size. */
export function validGeometry(cols: unknown, rows: unknown): cols is number {
  return typeof cols === "number"
    && typeof rows === "number"
    && Number.isFinite(cols)
    && Number.isFinite(rows)
    && cols > 0
    && rows > 0
    && cols <= 500
    && rows <= 250;
}
