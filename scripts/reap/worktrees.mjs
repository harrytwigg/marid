// Which build worktrees a sweep may remove, and why.
//
// A run that dies mid-phase never reaches its cleanup step, so its worktree
// stays forever. Preserving one for a short while is correct — a re-armed Todo
// resumes from the branch — but immortality is how 40 GB of dead trees piles up.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const TODO_ID = /\b([A-Z]{3}-\d+)\b/
const CLOSED_TODO_STATUSES = new Set(["done", "cancelled"])

/**
 * Only a directory that is *directly* under the worktrees root and named
 * `hundredfold-*`. The repo checkout and every path inside a worktree are structurally
 * unreachable, which is what keeps a bug here from deleting the checkout.
 */
export function isEligibleWorktree(candidatePath, worktreesRoot) {
  const resolved = path.resolve(candidatePath)
  if (path.dirname(resolved) !== path.resolve(worktreesRoot)) return false
  return path.basename(resolved).startsWith("hundredfold-")
}

/** The Todo a worktree was cut for, read out of its directory name. */
export function todoIdFromWorktree(candidatePath) {
  const match = TODO_ID.exec(path.basename(path.resolve(candidatePath)))
  return match ? match[1] : null
}

/**
 * `todoStatus` is null when the lookup could not be made. That skips the
 * closed-Todo rule rather than deciding it: a gateway being unreachable is not
 * evidence that work is finished.
 *
 * @returns {{ prune: boolean, reason: string }}
 */
export function classifyWorktree(candidate, options) {
  if (!isEligibleWorktree(candidate.path, options.worktreesRoot)) {
    return { prune: false, reason: "not-a-build-worktree" }
  }
  if (candidate.missing) return { prune: false, reason: "already-gone" }
  if (candidate.dirty) return { prune: false, reason: "uncommitted-changes" }
  if (candidate.ageMinutes < options.minAgeMinutes) return { prune: false, reason: "too-young" }
  if (candidate.merged) return { prune: true, reason: "merged-into-main" }
  if (!candidate.todoStatus) return { prune: false, reason: "todo-unknown" }
  if (CLOSED_TODO_STATUSES.has(candidate.todoStatus)) return { prune: true, reason: "todo-closed" }
  return { prune: false, reason: "todo-open" }
}

/**
 * The path with every symlink resolved, or the plain absolute path when it does
 * not exist. Eligibility compares a directory against its parent, and git
 * reports real paths while a caller composes lexical ones — on a machine whose
 * temp dir is a symlink the two never match and nothing is ever eligible.
 */
export function realPath(candidatePath) {
  try {
    return fs.realpathSync(candidatePath)
  } catch {
    return path.resolve(candidatePath)
  }
}

/**
 * The primary checkout, given any checkout of the same repository. The sweep is
 * routinely launched from inside a worktree, where deriving the worktrees root
 * from the current directory points a level too deep and silently finds nothing.
 * The common git dir always lives in the primary checkout, so it is the anchor.
 */
export function mainCheckout(repo, git) {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  return common === null ? realPath(repo) : realPath(path.dirname(common.trim()))
}

/** Every worktree git knows about, minus the checkout itself. */
export function listWorktrees(repo, git) {
  const listed = git(repo, ["worktree", "list", "--porcelain"])
  if (listed === null) return []
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realPath(line.slice("worktree ".length)))
    .filter((tree) => tree !== realPath(repo))
}

export function inspectWorktree(tree, { repo, git, now }) {
  const status = git(tree, ["status", "--porcelain"])
  const head = git(tree, ["rev-parse", "HEAD"])
  const modifiedAt = modifiedTime(tree)
  return {
    path: tree,
    // Git keeps listing a worktree whose directory was deleted by hand. That is
    // metadata for `git worktree prune` to clear rather than a tree to remove,
    // and stat-ing it must not take the whole sweep down.
    missing: modifiedAt === null,
    // A status we could not read counts as dirty: a tree we failed to inspect
    // is a tree we know nothing about, and the safe verdict is to keep it.
    dirty: status === null || status.trim().length > 0,
    ageMinutes: modifiedAt === null ? 0 : (now - modifiedAt) / 60_000,
    merged: head !== null && git(repo, ["merge-base", "--is-ancestor", head.trim(), "main"]) !== null,
  }
}

/** The directory's mtime, or null when it is no longer there to stat. */
function modifiedTime(tree) {
  try {
    return fs.statSync(tree).mtimeMs
  } catch {
    return null
  }
}

/** stdout on success, null on any failure — callers treat null as "unknown", never as a verdict. */
export function gitRunner(env) {
  return (cwd, args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] })
    return result.status === 0 ? result.stdout : null
  }
}

/**
 * The Todo's status, or null when the gateway cannot answer. Every failure —
 * no gateway, no token, a timeout, a 404 — is the same "unknown", because the
 * only decision it feeds skips itself on unknown.
 */
export async function fetchTodoStatus(todoId, { url, token, timeoutMs = 2000 }) {
  if (!todoId || !url || !token) return null
  try {
    const response = await fetch(`${url}/api/work-items/${todoId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json()
    return body?.workItem?.status ?? null
  } catch {
    return null
  }
}
