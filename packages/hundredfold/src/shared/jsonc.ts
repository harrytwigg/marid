// Kept apart from the engine code so the command line can read a settings file without loading anything
// that evaluates the home's paths.

/** The index just past the string literal that starts at `start`. */
function endOfString(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The index just past the comment that starts at `start`, or `start` when none does. */
function endOfComment(text: string, start: number): number {
  if (text[start] !== "/") return start;
  if (text[start + 1] === "/") {
    const eol = text.indexOf("\n", start);
    return eol < 0 ? text.length : eol;
  }
  if (text[start + 1] === "*") {
    const close = text.indexOf("*/", start + 2);
    return close < 0 ? text.length : close + 2;
  }
  return start;
}

/** JSON with `//` and block comments and trailing commas, as `opencode.jsonc` allows. */
export function parseJsonc(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, "");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const next = text[i] === '"' ? endOfString(text, i) : endOfComment(text, i);
    if (text[i] === '"') out += text.slice(i, next);
    else out += next === i ? text[i] : " ";
    i = next === i ? i + 1 : next;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, "$1"));
}
