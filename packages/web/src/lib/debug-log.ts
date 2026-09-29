// In-memory ring buffer for ad-hoc on-device debugging. Filled by sprinkled
// `dlog()` calls and dumped via the "Share debug log" button in the mobile more
// menu. Cap is small so a long session doesn't hog memory.

import { copyText, getPlatform, share } from "@/platform";
import { PRODUCT_NAME } from "@/lib/brand"

const MAX = 500;

interface Entry {
  t: number;
  tag: string;
  msg: string;
}

const buf: Entry[] = [];

export function dlog(tag: string, msg: string): void {
  buf.push({ t: Date.now(), tag, msg });
  if (buf.length > MAX) buf.shift();
}

export function getDebugLog(): string {
  if (buf.length === 0) return "(empty)";
  const t0 = buf[0].t;
  return buf
    .map((e) => {
      const ms = String(e.t - t0).padStart(6, " ");
      return `+${ms}ms [${e.tag}] ${e.msg}`;
    })
    .join("\n");
}

export function clearDebugLog(): void {
  buf.length = 0;
}

/** Share or copy the accumulated log. iOS Safari → native Share sheet; other → clipboard. */
export async function shareDebugLog(): Promise<void> {
  const text = getDebugLog();
  const ua = `\n\n--- UA: ${getPlatform().runtime.userAgent}\nViewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`;
  const payload = text + ua;
  const shared = await share({ title: `${PRODUCT_NAME} debug log`, text: payload });
  if (shared.status === "performed" || shared.status === "cancelled") return;

  const copied = await copyText(payload);
  if (copied.status === "performed") {
    alert(`Debug log copied to clipboard (${buf.length} entries)`);
    return;
  }
  // Last resort: dump into a textarea and tell the user to copy manually.
  prompt("Copy this log:", payload.slice(0, 4000));
}
