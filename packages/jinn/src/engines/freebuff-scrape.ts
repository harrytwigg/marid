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

/** Where the conversation sits on the screen: the user's stamp, and the footer that closes the turn. */
function locate(lines: readonly string[]): { stamp: number; footer: number } | undefined {
  let footer = -1;
  lines.forEach((l, i) => { if (FOOTER.test(l)) footer = i; });
  let stamp = -1;
  lines.forEach((l, i) => { if ((footer < 0 || i < footer) && STAMP.test(l)) stamp = i; });
  return footer < 0 || stamp < 0 ? undefined : { stamp, footer };
}

/** Whether a line is a tool call or its output rather than the model's text. */
function isToolLine(line: string): boolean {
  return /^\s*•\s/.test(line) || /^\s*\$\s/.test(line);
}

/** Drop the `• Thinking` blocks: a header, then lines indented under it, up to a blank line. */
function withoutReasoning(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let thinking = false;
  for (const line of lines) {
    if (/^\s*•\s*Thinking\b/.test(line)) thinking = true;
    else if (thinking && (!line.trim() || /^\s{4,}\S/.test(line))) thinking = !!line.trim();
    else {
      thinking = false;
      kept.push(line);
    }
  }
  return kept;
}

export function scrapeAnswer(lines: readonly string[]): string | undefined {
  const where = locate(lines);
  if (!where) return undefined;
  // The stamp, then the user's message (which may wrap), then a blank line.
  let start = where.stamp + 1;
  while (start < where.footer && lines[start].trim()) start++;
  const body = lines.slice(start, where.footer).map((raw) => raw.replace(SCROLLBAR, "").replace(/\s+$/, ""));
  const text = withoutReasoning(body)
    .filter((line) => !isToolLine(line))
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}
