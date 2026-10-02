/**
 * The `@employee` mentions in a comment body, in order of first appearance.
 *
 * A token is `@` at the start of the text or after a character that cannot
 * continue a word, address or path (so `x@y.com` and `a/@b` are not mentions),
 * then a slug: a letter or digit, then letters, digits, `-` and `_`, with a
 * trailing `-` or `_` dropped as punctuation. Slugs are matched lowercased.
 * Anything inside a fenced code block (``` or ~~~) or an inline code span is
 * quoted, not addressed, and is skipped.
 *
 * This finds candidates only: whether a slug names someone who can be woken is
 * the roster's answer, not the parser's. The web client applies the same rule
 * to decide what to highlight.
 */
const MENTION = /(^|[^A-Za-z0-9_.@/-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?(```|$)|~~~[\s\S]*?(~~~|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

export function parseMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of withoutCode(body).matchAll(MENTION)) {
    const slug = match[2].replace(/[-_]+$/, '').toLowerCase();
    if (slug) found.add(slug);
  }
  return [...found];
}
