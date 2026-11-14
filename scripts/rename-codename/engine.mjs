// The codemod's engine: a case-preserving word map, plus the places it must not touch.
// Pure functions over strings and paths, so the rules can be tested without a checkout.
import path from "node:path";

export const TARGET = "hundredfold";
const WORD = /jinn|marid/gi;

/** Names that are one phrase, not a word inside one: the old package is the new package, not `hundredfold-cli`. */
export const PHRASES = [[/jinn-cli/g, "hundredfold"], [/Jinn-cli/g, "Hundredfold"]];

/** `jinn` becomes `hundredfold`, `Jinn` `Hundredfold`, `JINN` `HUNDREDFOLD`; the same for `marid`. */
export function mapWord(word) {
  if (word === word.toLowerCase()) return TARGET;
  if (word === word.toUpperCase()) return TARGET.toUpperCase();
  if (word === word[0].toUpperCase() + word.slice(1).toLowerCase()) return TARGET[0].toUpperCase() + TARGET.slice(1);
  throw new Error(`no case mapping for "${word}"`);
}

/**
 * Rewrite one text. `keep` is a list of regexes whose matches are left as they are (the attribution the licence asks
 * for). Returns the new text and what was left, so a guard can say what is allowed to remain.
 */
export function renameText(text, keep) {
  const lines = text.split("\n");
  const left = [];
  const out = lines.map((line, index) => {
    const held = [];
    let work = line;
    for (const pattern of keep) {
      work = work.replace(pattern, (match) => {
        held.push(match);
        return `\u0000${held.length - 1}\u0000`;
      });
    }
    if (held.length > 0 && /jinn|marid/i.test(held.join(" "))) left.push({ line: index + 1, text: line, why: "pattern" });
    for (const [pattern, replacement] of PHRASES) work = work.replace(pattern, replacement);
    return work.replace(WORD, mapWord).replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
  });
  return { text: out.join("\n"), changed: out.some((line, i) => line !== lines[i]), left };
}

function renameSegment(text) {
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement);
  return text.replace(WORD, mapWord);
}

/** Rewrite a path, segment by segment. Under a frozen subtree the part after the matched prefix keeps its names. */
export function renamePath(relPath, frozenSubtrees) {
  for (const subtree of frozenSubtrees) {
    const match = subtree.exec(relPath);
    if (match) return renameSegment(relPath.slice(0, match[0].length)) + relPath.slice(match[0].length);
  }
  return renameSegment(relPath);
}

export function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

export function extensionOf(relPath) {
  return path.extname(relPath).toLowerCase();
}
