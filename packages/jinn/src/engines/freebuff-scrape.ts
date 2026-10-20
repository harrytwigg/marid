/**
 * The answer as the screen shows it, for when the chat file cannot be read.
 *
 * A fallback, and a poor one: the screen wraps long lines, truncates long
 * output, and mixes the model's text with its reasoning and tool output. It is
 * only ever used after the chat file has failed, and the engine logs that it was.
 *
 * What it takes: everything from the line after the user's message (the one
 * with the `[04:50 PM]` stamp above it) down to the turn footer (`⎘ • 11s • △▽`),
 * minus the `• Thinking` blocks and the scrollbar glyphs in the right margin.
 */

const STAMP = /^\s*\[\d{1,2}:\d{2}\s?[AP]M\]\s*$/;
const FOOTER = /⎘\s*•\s*[0-9hms ]+•/;
const SCROLLBAR = /[\s▀▄█]+$/;

export function scrapeAnswer(lines: readonly string[]): string | undefined {
  let footer = -1;
  lines.forEach((l, i) => { if (FOOTER.test(l)) footer = i; });
  let stamp = -1;
  lines.forEach((l, i) => { if ((footer < 0 || i < footer) && STAMP.test(l)) stamp = i; });
  if (footer < 0 || stamp < 0) return undefined;

  // The stamp, then the user's message (which may wrap), then a blank line.
  let start = stamp + 1;
  while (start < footer && lines[start].trim()) start++;
  const kept: string[] = [];
  let thinking = false;
  for (const raw of lines.slice(start, footer)) {
    const line = raw.replace(SCROLLBAR, "").replace(/\s+$/, "");
    if (/^\s*•\s*Thinking\b/.test(line)) { thinking = true; continue; }
    if (thinking) {
      // Reasoning is indented under its header; it ends at the first line that is not.
      if (/^\s{4,}\S/.test(line) || !line.trim()) { if (!line.trim()) thinking = false; continue; }
      thinking = false;
    }
    if (/^\s*•\s/.test(line) || /^\s*\$\s/.test(line)) continue; // a tool call, not the answer
    kept.push(line.replace(/^ {2}/, ""));
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || undefined;
}
