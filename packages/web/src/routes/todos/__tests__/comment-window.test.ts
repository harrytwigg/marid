import { describe, expect, it } from "vitest"
import type { WorkItemCommentPageWire, WorkItemCommentWire } from "@/lib/api"
import { commentHeadRequest, mergeCommentPages } from "../task-page/comment-window"

/* The detail payload already carries the last 10 comments, so the
 * page asks only for the head the tail is missing and unions the two. */

function comment(id: string, at: string): WorkItemCommentWire {
  return {
    id, workItemId: "TSK-12", parentCommentId: null, authorKind: "employee", author: "mason",
    body: id, createdAt: at, editedAt: null, deletedAt: null,
  }
}

function page(comments: WorkItemCommentWire[], total = comments.length): WorkItemCommentPageWire {
  return { comments, total }
}

/** `n` comments an hour apart, oldest first — c01, c02, … */
function thread(n: number): WorkItemCommentWire[] {
  return Array.from({ length: n }, (_, i) => comment(`c${String(i + 1).padStart(2, "0")}`, `2026-07-2${1 + Math.floor(i / 24)}T${String(i % 24).padStart(2, "0")}:00:00.000Z`))
}

describe("the comment head window", () => {
  it("asks only for what the tail is missing", () => {
    const all = thread(13)
    expect(commentHeadRequest(page(all.slice(3), 13))).toEqual({ limit: 3, offset: 0 })
  })

  it("asks for nothing when the tail is the whole thread", () => {
    expect(commentHeadRequest(page(thread(3)))).toBeNull()
    expect(commentHeadRequest(page([], 0))).toBeNull()
  })

  it("falls back to the whole first page when a gateway embeds no tail", () => {
    expect(commentHeadRequest(undefined)).toEqual({ limit: 500, offset: 0 })
  })

  it("never asks for more than one page", () => {
    expect(commentHeadRequest(page(thread(10), 900))).toEqual({ limit: 500, offset: 0 })
  })
})

describe("merging the head window with the embedded tail", () => {
  it("returns the whole thread once, in order", () => {
    const all = thread(13)
    const merged = mergeCommentPages(page(all.slice(0, 3), 13), page(all.slice(3), 13))
    expect(merged.map((c) => c.id)).toEqual(all.map((c) => c.id))
  })

  it("keeps each id once when a concurrent write makes the windows overlap", () => {
    // A comment lands between the two requests: rows shift down, so the head
    // page returns one the tail also carries. Ids do not shift.
    const all = thread(14)
    const merged = mergeCommentPages(page(all.slice(0, 5), 14), page(all.slice(4), 14))
    expect(merged.map((c) => c.id)).toEqual(all.map((c) => c.id))
    expect(new Set(merged.map((c) => c.id)).size).toBe(merged.length)
  })

  it("reads as the tail alone while the head is still in flight", () => {
    const tail = page(thread(13).slice(3), 13)
    expect(mergeCommentPages(undefined, tail)).toEqual(tail.comments)
  })
})
