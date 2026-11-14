import { parseTodoId } from "../work-items/id.js";
import type { FacetKind, ParsedQuery, QueryFacet, QuerySpan } from "./types.js";

/**
 * The query grammar: plain words and explicit tokens, both.
 *
 * `blocked on hundredfold-dev` infers the same facets `is:blocked @hundredfold-dev` commits
 * explicitly, and when the two disagree the explicit token wins. Inference only
 * ever draws on the live vocabulary, so it can narrow a search but never invent
 * a facet that does not exist.
 *
 * Pure by construction — no db, no filesystem, no clock. `vocabulary.ts` owns
 * the impure half, which is what makes every rule here unit-testable.
 */

export interface SearchVocabulary {
  statuses: readonly string[];
  assignees: readonly string[];
  departments: readonly string[];
  labels: readonly string[];
}

export type ParseSearchQueryResult =
  | { ok: true; value: ParsedQuery }
  | { ok: false; error: string };

interface TokenForm {
  kind: FacetKind;
  prefix: string;
}

const TOKEN_FORMS: readonly TokenForm[] = [
  { kind: "assignee", prefix: "@" },
  { kind: "label", prefix: "#" },
  { kind: "status", prefix: "is:" },
  { kind: "department", prefix: "in:" },
];

/** Inference order: the first kind whose vocabulary holds the word wins it. */
const INFERENCE_ORDER: readonly FacetKind[] = ["status", "assignee", "department", "label"];

/** What an unmatched explicit token is told it failed to name. */
const TOKEN_MISS: Record<FacetKind, string> = {
  status: "is not a Todo status",
  assignee: "does not name anyone on the roster",
  department: "does not name a department",
  label: "does not name an existing label",
};

/**
 * Words that only ever glue a query together. They are dropped ONLY when at
 * least one facet was found: without that condition `all hands on deck` would
 * silently become `hands deck`, and with it `everything blocked on hundredfold-dev`
 * stops ANDing `everything` and `on` into the index and returning nothing.
 */
const CONNECTIVES = new Set(["everything", "all", "on", "for", "in", "by", "with", "the", "show", "me"]);

interface Word {
  text: string;
  start: number;
  end: number;
}

function words(input: string): Word[] {
  const found: Word[] = [];
  for (const match of input.matchAll(/\S+/g)) {
    found.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return found;
}

function spanOf(word: Word): QuerySpan {
  return { start: word.start, end: word.end, text: word.text };
}

function vocabularyFor(vocabulary: SearchVocabulary, kind: FacetKind): readonly string[] {
  if (kind === "status") return vocabulary.statuses;
  if (kind === "assignee") return vocabulary.assignees;
  if (kind === "department") return vocabulary.departments;
  return vocabulary.labels;
}

/** The canonical vocabulary entry equal to `word`, compared case-insensitively. */
function canonical(values: readonly string[], word: string): string | undefined {
  const lowered = word.toLocaleLowerCase();
  return values.find((value) => value.toLocaleLowerCase() === lowered);
}

/** A bare `@` or `is:` names nothing, so it stays ordinary text. */
function tokenIn(text: string): { kind: FacetKind; value: string } | undefined {
  for (const form of TOKEN_FORMS) {
    if (!text.startsWith(form.prefix)) continue;
    const value = text.slice(form.prefix.length);
    if (value) return { kind: form.kind, value };
  }
  return undefined;
}

type WordOutcome =
  | { outcome: "facet"; facet: QueryFacet }
  | { outcome: "text" }
  | { outcome: "error"; error: string };

function readWord(word: Word, vocabulary: SearchVocabulary): WordOutcome {
  const token = tokenIn(word.text);
  if (token) {
    const value = canonical(vocabularyFor(vocabulary, token.kind), token.value);
    if (!value) {
      return {
        outcome: "error",
        error: `"${word.text}" ${TOKEN_MISS[token.kind]} — drop the token, or pass literal=true to search for it as text`,
      };
    }
    return { outcome: "facet", facet: { kind: token.kind, value, origin: "token", span: spanOf(word) } };
  }
  for (const kind of INFERENCE_ORDER) {
    const value = canonical(vocabularyFor(vocabulary, kind), word.text);
    if (value) return { outcome: "facet", facet: { kind, value, origin: "inferred", span: spanOf(word) } };
  }
  return { outcome: "text" };
}

/**
 * One facet per kind. An explicit token always replaces an inference; among
 * facets of the same origin the first one typed stands. The losing word is
 * consumed either way — it was an attempt to name a facet, not a search term,
 * and putting it back into the free text would AND a status word into the index.
 */
function keepFacet(chosen: Map<FacetKind, QueryFacet>, facet: QueryFacet): void {
  const held = chosen.get(facet.kind);
  if (!held || (held.origin === "inferred" && facet.origin === "token")) chosen.set(facet.kind, facet);
}

function asTodoId(text: string): string | null {
  try {
    return parseTodoId(text);
  } catch {
    return null; // ordinary text, not an id
  }
}

function query(facets: QueryFacet[], freeText: string, literal: boolean): ParsedQuery {
  return { facets, freeText, todoId: asTodoId(freeText), literal };
}

export function parseSearchQuery(
  input: string,
  vocabulary: SearchVocabulary,
  options: { literal?: boolean },
): ParseSearchQueryResult {
  const raw = input.trim();
  if (options.literal) return { ok: true, value: query([], raw, true) };

  const chosen = new Map<FacetKind, QueryFacet>();
  const residue: Word[] = [];
  for (const word of words(raw)) {
    const read = readWord(word, vocabulary);
    if (read.outcome === "error") return { ok: false, error: read.error };
    if (read.outcome === "text") residue.push(word);
    else keepFacet(chosen, read.facet);
  }

  const facets = [...chosen.values()].sort((left, right) => left.span.start - right.span.start);
  const kept = facets.length > 0
    ? residue.filter((word) => !CONNECTIVES.has(word.text.toLocaleLowerCase()))
    : residue;
  return { ok: true, value: query(facets, kept.map((word) => word.text).join(" "), false) };
}
