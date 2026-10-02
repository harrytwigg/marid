import { execFile } from "node:child_process";

/**
 * The state of the GitHub pull requests and issues a Todo links to, so a gate
 * like "once #18 merges" can be read against the truth rather than guessed.
 *
 * Only full GitHub URLs are resolved: a bare `#18` names no repository. Lookups
 * go through the `gh` CLI with whatever authentication the host already has; a
 * missing `gh`, no network or no access reads as `unknown` with the reason, and
 * the walk treats an unknown gate as not met. Results are cached briefly so a
 * Todo with the same link in ten comments costs one call.
 */

export interface LinkState {
  url: string;
  kind: "pull" | "issue";
  /** OPEN, CLOSED, MERGED — or unknown, with why. */
  state: string;
  title?: string;
  mergedAt?: string;
  closedAt?: string;
  error?: string;
}

export type LinkResolver = (url: string, kind: "pull" | "issue") => Promise<LinkState>;

const LINK = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/g;

/** Distinct GitHub PR and issue URLs in `texts`, in first-seen order. */
export function findLinks(texts: ReadonlyArray<string | null | undefined>, limit = 10): Array<{ url: string; kind: "pull" | "issue" }> {
  const seen = new Map<string, "pull" | "issue">();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(LINK)) {
      const [, owner, repo, type, number] = match;
      const url = `https://github.com/${owner}/${repo}/${type}/${number}`;
      if (!seen.has(url)) seen.set(url, type === "pull" ? "pull" : "issue");
      if (seen.size >= limit) break;
    }
  }
  return [...seen].map(([url, kind]) => ({ url, kind }));
}

function gh(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });
}

function linkState(url: string, kind: "pull" | "issue", raw: Record<string, unknown>): LinkState {
  const field = (key: string): string | undefined => (typeof raw[key] === "string" && raw[key] ? raw[key] as string : undefined);
  const title = field("title");
  const mergedAt = field("mergedAt");
  const closedAt = field("closedAt");
  return {
    url, kind,
    state: field("state") ?? "unknown",
    ...(title ? { title } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
  };
}

export function ghResolver(timeoutMs = 15_000): LinkResolver {
  return async (url, kind) => {
    const fields = kind === "pull" ? "state,title,mergedAt,closedAt" : "state,title,closedAt";
    try {
      return linkState(url, kind, JSON.parse(await gh([kind === "pull" ? "pr" : "issue", "view", url, "--json", fields], timeoutMs)) as Record<string, unknown>);
    } catch (error) {
      return { url, kind, state: "unknown", error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** A resolver that remembers answers for `ttlMs`. Unknowns are not cached. */
export function cachedResolver(inner: LinkResolver, ttlMs = 10 * 60_000, now: () => number = Date.now): LinkResolver {
  const cache = new Map<string, { at: number; value: LinkState }>();
  return async (url, kind) => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await inner(url, kind);
    if (value.state !== "unknown") cache.set(url, { at: now(), value });
    return value;
  };
}
