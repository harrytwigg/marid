import { assertBoundCaller, gatewayGet, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import { hasControlBytes } from "../shared/sanitize.js";
import { KNOWLEDGE_FILE_CHAR_CAP } from "../shared/knowledge-read.js";

/**
 * GRS-020b — the knowledge tool group of the `jinn` MCP server: agents search
 * the company's institutional knowledge (`~/.jinn/knowledge/*.md` +
 * `~/.jinn/docs/*.md`) and read ONE instance file — replacing the ~100-file knowledge
 * index pasted into every MCP-attached bootstrap (the conditional diet in
 * sessions/context.ts).
 *
 * Domain rules this module owns:
 *   - INSTANCE-ROOT INVARIANT (enforced in notes/store.ts behind the
 *     routes): reads accept any relative instance file, while realpath
 *     containment rejects `..`, absolute paths, and symlink escapes.
 *   - CONTEXT-BOMB GUARDS: search returns ≤20 {path,title,snippet,matchCount}
 *     hits (snippets ~12 words, never bodies); read returns ONE slice of ONE file,
 *     capped at KNOWLEDGE_FILE_CHAR_CAP chars, with `offset` to page the rest.
 *   - NO FABRICATED READS (PLA-100): a response missing `content`, `truncated`,
 *     or the char counts is an error, never a defaulted "complete" read.
 *   - READ TIER: these are privileged company reads. Tool-marked or
 *     caller-session-claimed requests must carry a valid bound session
 *     capability; operator/browser reads without those headers remain unchanged.
 *   - LENGTH CAPS (the 020a-fix finding-3 pattern): query/path are capped
 *     tool-side with a structured error BEFORE the HTTP call.
 *   - TEACHING lives on search_knowledge; read_knowledge stays short.
 */

/** Tool-side query cap (route backstop is 1,024 — the tool fails first, friendlier). */
export const KNOWLEDGE_QUERY_CHAR_CAP = 512;
/** Tool-side relative-path cap (real paths are far shorter). */
export const KNOWLEDGE_PATH_CHAR_CAP = 300;

function requireString(args: Record<string, unknown>, name: string, max: number): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  if (s.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${s.length} chars, max ${max}) — shorten it and try again`);
  }
  return s;
}

/** Optional paging offset, refused tool-side (no HTTP call) when it is not a
 *  non-negative integer — the route mirrors the same rule. */
function requireOffset(args: Record<string, unknown>): number {
  const v = args.offset;
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new JinnMcpToolError(`offset must be a non-negative integer — got ${JSON.stringify(v)}`);
  }
  return v;
}

interface KnowledgeReadBody {
  path?: string;
  title?: string;
  content: string;
  truncated: boolean;
  totalChars: number;
  returnedChars: number;
  offset: number;
}

/** The gateway's read payload, or a loud error. Every field describing how much
 *  of the file this is comes back required: defaulting `truncated` to false or
 *  `content` to "" turns a broken response into a read that looks whole, which
 *  is the failure the caller has no way to detect. */
function requireReadBody(body: unknown, what: string): KnowledgeReadBody {
  const rec = (body ?? {}) as Record<string, unknown>;
  const malformed = (name: string, kind: string): JinnMcpToolError =>
    new JinnMcpToolError(`${what} returned a malformed response: ${name} is missing or not ${kind}`);
  if (typeof rec.content !== "string") throw malformed("content", "a string");
  if (typeof rec.truncated !== "boolean") throw malformed("truncated", "a boolean");
  for (const name of ["totalChars", "returnedChars", "offset"] as const) {
    if (!Number.isInteger(rec[name])) throw malformed(name, "an integer");
  }
  return rec as unknown as KnowledgeReadBody;
}

function asText(body: unknown, max = 500): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Non-2xx gateway response → a readable tool error (structured bodies pass through). */
function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail}`);
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

/** Instance wording for knowledge search (config `knowledge.*`); both absent leaves the built-in text. */
export interface KnowledgeSearchWording {
  guidance?: string;
  missHint?: string;
}

export function buildKnowledgeTools(wording: KnowledgeSearchWording = {}): JinnMcpTool[] {
  const guidance = wording.guidance?.trim();
  const missHint = wording.missHint?.trim();
  const searchKnowledge: JinnMcpTool = {
    name: "search_knowledge",
    description: `Search knowledge/ and docs/ markdown; snippets only.${guidance ? ` ${guidance}` : ""}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const query = requireString(args, "query", KNOWLEDGE_QUERY_CHAR_CAP);
      const { status, body } = await gatewayGet(ctx, `/api/knowledge/search?q=${encodeURIComponent(query)}`);
      if (status >= 400) throw gatewayFailure("searching knowledge", status, body);
      const rec = (body ?? {}) as { results?: Array<Record<string, unknown>> };
      const results = Array.isArray(rec.results) ? rec.results : [];
      return {
        query,
        results,
        hint:
          results.length === 0
            ? missHint || "No hits. Try fewer words."
            : "Next: read_knowledge { path }.",
      };
    },
  };

  const readKnowledge: JinnMcpTool = {
    name: "read_knowledge",
    description: `Read one instance file by relative path, ${KNOWLEDGE_FILE_CHAR_CAP} chars per call; offset pages the rest.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      if (typeof args.path === "string" && hasControlBytes(args.path)) {
        throw new JinnMcpToolError(
          "path contains control bytes — pass the instance-relative path exactly",
        );
      }
      const relPath = requireString(args, "path", KNOWLEDGE_PATH_CHAR_CAP);
      const offset = requireOffset(args);
      const what = `reading instance file "${relPath}"`;
      const query = `path=${encodeURIComponent(relPath)}${offset > 0 ? `&offset=${offset}` : ""}`;
      const { status, body } = await gatewayGet(ctx, `/api/knowledge/read?${query}`);
      if (status >= 400) throw gatewayFailure(what, status, body);
      const read = requireReadBody(body, what);
      const nextOffset = read.offset + read.returnedChars;
      return {
        path: read.path ?? relPath,
        title: read.title ?? null,
        truncated: read.truncated,
        totalChars: read.totalChars,
        returnedChars: read.returnedChars,
        offset: read.offset,
        content: read.content,
        hint: read.truncated
          ? `${read.totalChars - nextOffset} chars left — read_knowledge { path, offset: ${nextOffset} } for the next slice.`
          : "Cite path when useful.",
      };
    },
  };

  return [searchKnowledge, readKnowledge];
}
