import { loadJobs } from "../cron/jobs.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { listSkills } from "../gateway/skills-api.js";
import { listNotes } from "../notes/store.js";
import { searchSessionsFiltered, type SearchSessionsFilter } from "../sessions/registry.js";
import type { JinnConfig, NoteSummary, Session } from "../shared/types.js";
import { facetReasons, snippetAround, withoutMarks } from "./match-reason.js";
import type { GlobalSearchResult, ParsedQuery, SearchKind, SearchMatchField, SearchMatchReason } from "./types.js";

/**
 * The six kinds that are not Todos. None of them has a text index, so each one
 * declares the fields it can be found by and a shared matcher does the rest —
 * one rule for word-order tolerance instead of six.
 *
 * Only Todos carry full bodies here: a note matches on its title, path and
 * preview, not its whole text. `/api/notes?q=` still searches note bodies.
 */

interface EntityField {
  field: SearchMatchField;
  value: string;
}

/** An entity reduced to what search needs: how to show it, where it goes, and
 *  the text it can be found by. */
interface Candidate {
  id: string;
  title: string;
  url: string;
  subtitle?: string;
  status?: string;
  owner?: string;
  /** Read in order, so the first reason is the most identifying one. */
  fields: EntityField[];
}

/**
 * Every word has to land somewhere in the entity — the same AND semantics the
 * Todo index applies — so word order never decides a hit. The reasons come from
 * whichever fields the words actually landed in.
 */
function reasonsFor(candidate: Candidate, words: readonly string[]): SearchMatchReason[] | null {
  if (words.length === 0) return null;
  const haystack = candidate.fields.map((field) => field.value).join("\n").toLocaleLowerCase();
  if (!words.every((word) => haystack.includes(word.toLocaleLowerCase()))) return null;
  const reasons: SearchMatchReason[] = [];
  for (const field of candidate.fields) {
    const snippet = snippetAround(field.value, words);
    if (snippet) reasons.push({ field: field.field, snippet });
  }
  return reasons.length > 0 ? reasons : null;
}

function toResult(kind: SearchKind, candidate: Candidate, reason: SearchMatchReason[]): GlobalSearchResult {
  return {
    kind,
    id: candidate.id,
    title: candidate.title,
    url: candidate.url,
    reason,
    preview: {
      title: candidate.title,
      ...(candidate.subtitle ? { subtitle: candidate.subtitle } : {}),
      ...(candidate.status ? { status: candidate.status } : {}),
      ...(candidate.owner ? { owner: candidate.owner } : {}),
      excerpt: withoutMarks(reason[0].snippet),
      url: candidate.url,
    },
  };
}

export function textWords(freeText: string): string[] {
  return freeText.split(/\s+/).filter((word) => word.length > 0);
}

export function searchEntities(
  kind: SearchKind,
  candidates: readonly Candidate[],
  words: readonly string[],
  limit: number,
): { results: GlobalSearchResult[]; total: number } {
  const matched: GlobalSearchResult[] = [];
  for (const candidate of candidates) {
    const reason = reasonsFor(candidate, words);
    if (reason) matched.push(toResult(kind, candidate, reason));
  }
  return { results: matched.slice(0, limit), total: matched.length };
}

export function employeeCandidates(config?: JinnConfig): Candidate[] {
  return [...orgRegistry(config).values()].map((employee) => ({
    id: employee.name,
    title: employee.displayName,
    url: "/org",
    subtitle: `${employee.department} · ${employee.rank}`,
    owner: employee.name,
    fields: [
      { field: "name" as const, value: `${employee.displayName} (${employee.name})` },
      { field: "department" as const, value: employee.department },
      { field: "persona" as const, value: employee.persona },
    ],
  }));
}

export function cronCandidates(): Candidate[] {
  return loadJobs().map((job) => ({
    id: job.id,
    title: job.name,
    url: `/cron/${encodeURIComponent(job.id)}`,
    subtitle: job.schedule,
    status: job.enabled ? "enabled" : "disabled",
    ...(job.employee ? { owner: job.employee } : {}),
    fields: [
      { field: "name" as const, value: `${job.name} (${job.id})` },
      { field: "prompt" as const, value: job.prompt },
    ],
  }));
}

export function skillCandidates(): Candidate[] {
  return listSkills().map((skill) => ({
    id: skill.name,
    title: skill.name,
    url: `/skills/${encodeURIComponent(skill.name)}`,
    fields: [
      { field: "name" as const, value: skill.name },
      { field: "description" as const, value: skill.description },
    ],
  }));
}

/** Mirrors `buildNotesPath` in the web app: `knowledge/a/b.md` opens at
 *  `/notes/f/a/n/a/b`. */
function noteUrl(note: NoteSummary): string {
  const rel = note.path.replace(/^knowledge\//, "").replace(/\.md$/, "");
  const encoded = rel.split("/").map(encodeURIComponent).join("/");
  return `/notes/${note.folder ? `f/${encodeURIComponent(note.folder)}` : "all"}/n/${encoded}`;
}

export function noteCandidates(home?: string): Candidate[] {
  return listNotes(home ? { home } : {}).notes.map((note) => ({
    id: note.path,
    title: note.title,
    url: noteUrl(note),
    subtitle: note.folder || "knowledge",
    fields: [
      { field: "title" as const, value: note.title },
      { field: "path" as const, value: note.path },
      { field: "body" as const, value: note.preview },
    ],
  }));
}

/**
 * The nav destinations ⌘K can open. The web router owns the paths
 * (`packages/web/src/lib/app-routes.ts`) and the sidebar owns the labels, and
 * the gateway can import neither — so this is a third copy that drifts if a
 * page is added without touching it. Recorded rather than solved: a shared
 * package for eleven strings would cost more than it saves today.
 */
const NAV_PAGES: readonly { id: string; title: string; url: string; keywords: string }[] = [
  { id: "page-chat", title: "Chat", url: "/", keywords: "chat conversation sessions" },
  { id: "page-todos", title: "Todos", url: "/todos", keywords: "todos work items board kanban ledger" },
  { id: "page-notes", title: "Notes", url: "/notes", keywords: "notes knowledge documents" },
  { id: "page-org", title: "Organization", url: "/org", keywords: "org employees roster people departments" },
  { id: "page-cron", title: "Cron", url: "/cron", keywords: "cron schedule jobs" },
  { id: "page-limits", title: "Limits", url: "/limits", keywords: "limits usage quota" },
  { id: "page-logs", title: "Activity", url: "/logs", keywords: "logs activity events" },
  { id: "page-skills", title: "Skills", url: "/skills", keywords: "skills playbooks" },
  { id: "page-settings", title: "Settings", url: "/settings", keywords: "settings configuration preferences" },
];

export function pageCandidates(notesEnabled: boolean): Candidate[] {
  return NAV_PAGES.filter((page) => notesEnabled || page.id !== "page-notes").map((page) => ({
    id: page.id,
    title: page.title,
    url: page.url,
    subtitle: page.url,
    fields: [
      { field: "name" as const, value: page.title },
      { field: "path" as const, value: page.url },
      { field: "description" as const, value: page.keywords },
    ],
  }));
}

function sessionCandidate(session: Session): Candidate {
  const title = session.title ?? session.promptExcerpt ?? session.id;
  return {
    id: session.id,
    title,
    // Sessions have no route of their own; Enter lands on the chat surface.
    url: "/",
    subtitle: session.employee ?? session.engine,
    status: session.status,
    ...(session.employee ? { owner: session.employee } : {}),
    fields: [
      { field: "title" as const, value: title },
      { field: "id" as const, value: session.id },
      { field: "name" as const, value: session.employee ?? session.engine },
    ],
  };
}

/**
 * Sessions are filtered in SQL rather than in process — there are far too many
 * to enumerate — so an assignee facet becomes the employee filter and the free
 * text becomes the text filter.
 */
export function searchSessions(parsed: ParsedQuery, limit: number): { results: GlobalSearchResult[]; total: number } {
  const filter: SearchSessionsFilter = {};
  if (parsed.freeText) filter.text = parsed.freeText;
  const assignee = parsed.facets.find((facet) => facet.kind === "assignee");
  if (assignee) filter.employee = assignee.value;
  if (Object.keys(filter).length === 0) return { results: [], total: 0 };

  // One row past the cap is how truncation is known without a second query, so
  // `total` is a floor for this kind rather than an exact count.
  const rows = searchSessionsFiltered(filter, limit + 1);
  const words = textWords(parsed.freeText);
  const results = rows.slice(0, limit).map((session) => {
    const candidate = sessionCandidate(session);
    return toResult("session", candidate, reasonsFor(candidate, words) ?? facetReasons(parsed, candidate.title));
  });
  return { results, total: rows.length };
}
