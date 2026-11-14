/** The contract for reading ONE instance file: how much comes back per call and
 *  what the result says about it. Shared because three layers depend on it — the
 *  store produces it, the read route serializes it, and the MCP tool names the cap
 *  in its own description rather than reaching across to the store it calls over HTTP. */

/** Chars returned per read. Anything beyond is reached with `offset`, never dropped silently. */
export const KNOWLEDGE_FILE_CHAR_CAP = 20_000;

export type KnowledgeReadResult =
  /** `content` is the slice `[offset, offset + KNOWLEDGE_FILE_CHAR_CAP)` verbatim; `truncated`
   *  says the file continues past it, and `offset + returnedChars` is where the next slice starts. */
  | { ok: true; path: string; title: string; content: string; truncated: boolean; totalChars: number; returnedChars: number; offset: number }
  | { ok: false; reason: "invalid-path" | "invalid-offset" | "forbidden" | "not-found"; detail: string };
