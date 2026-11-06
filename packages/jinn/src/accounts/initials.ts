/** The letters a person's avatar shows: first and last word's first letters, or the first two of a single word. Same rule as the web's. */
export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return [...words[0]!].slice(0, 2).join("").toUpperCase();
  return ([...words[0]!][0]! + [...words[words.length - 1]!][0]!).toUpperCase();
}
