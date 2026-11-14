import { describe, it, expect, afterEach, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from HUNDREDFOLD_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-wi-comment-attach-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Store = typeof import("../store.js");
type Comments = typeof import("../comments.js");
type Attachments = typeof import("../attachments.js");
type CommentAttachments = typeof import("../comment-attachments.js");
let store: Store;
let comments: Comments;
let attachments: Attachments;
let commentAttachments: CommentAttachments;

const OPERATOR = { author: "operator", authorKind: "operator", operator: true } as const;
const LEAD = { author: "a-lead", authorKind: "employee", operator: false } as const;

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  attachments = await import("../attachments.js");
  commentAttachments = await import("../comment-attachments.js");
});

function stage(content: Buffer | string): string {
  return attachments.stageAttachmentBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content));
}

describe("listCommentAttachments", () => {
  it("returns a comment's own rows oldest first, and never the item's or another comment's", () => {
    const item = store.createWorkItem({ title: "scoped attachments" });
    const mine = comments.addComment({ workItemId: item.id, body: "Mine.", ...OPERATOR });
    const theirs = comments.addComment({ workItemId: item.id, body: "Theirs.", ...LEAD });
    attachments.addAttachment({ workItemId: item.id, filename: "item.txt", mime: "text/plain",
      stagedPath: stage("item level"), uploader: OPERATOR });
    const first = attachments.addAttachment({ workItemId: item.id, commentId: mine.id, filename: "first.png",
      mime: "image/png", stagedPath: stage("first"), uploader: OPERATOR });
    const second = attachments.addAttachment({ workItemId: item.id, commentId: mine.id, filename: "second.pdf",
      mime: "application/pdf", stagedPath: stage("second"), uploader: OPERATOR });
    attachments.addAttachment({ workItemId: item.id, commentId: theirs.id, filename: "theirs.png",
      mime: "image/png", stagedPath: stage("theirs"), uploader: LEAD });

    expect(commentAttachments.listCommentAttachments(mine.id)).toEqual([
      { id: first.id, mime: "image/png" },
      { id: second.id, mime: "application/pdf" },
    ]);
  });

  it("still lists the rows once the comment carrying them is tombstoned", () => {
    const item = store.createWorkItem({ title: "tombstoned host" });
    const comment = comments.addComment({ workItemId: item.id, body: "With a file.", ...OPERATOR });
    const row = attachments.addAttachment({ workItemId: item.id, commentId: comment.id, filename: "shot.png",
      mime: "image/png", stagedPath: stage("shot"), uploader: OPERATOR });
    comments.tombstoneComment(comment.id, OPERATOR);

    expect(commentAttachments.listCommentAttachments(comment.id)).toEqual([{ id: row.id, mime: "image/png" }]);
  });
});

describe("announceAttachment", () => {
  afterEach(() => commentAttachments.setTodoAttachmentListener(null));

  /** The reply race: the comment row commits and notifies BEFORE any of its
   *  uploads exist, so a parked Wait swept off the comment alone harvests an
   *  empty list. Each committed upload has to say so, or nothing ever re-wakes
   *  the sweep and the run keeps a reply it never actually received. */
  it("announces every committed attachment, so a late upload can re-wake the sweep", () => {
    const item = store.createWorkItem({ title: "late upload" });
    const comment = comments.addComment({ workItemId: item.id, body: "Files coming.", ...OPERATOR });
    const seen: Array<{ id: string; commentId: string | null }> = [];
    commentAttachments.setTodoAttachmentListener((attachment) => {
      seen.push({ id: attachment.id, commentId: attachment.commentId });
    });

    const first = attachments.addAttachment({ workItemId: item.id, commentId: comment.id, filename: "one.png",
      mime: "image/png", stagedPath: stage("one"), uploader: OPERATOR });
    const second = attachments.addAttachment({ workItemId: item.id, commentId: comment.id, filename: "two.png",
      mime: "image/png", stagedPath: stage("two"), uploader: OPERATOR });

    expect(seen).toEqual([
      { id: first.id, commentId: comment.id },
      { id: second.id, commentId: comment.id },
    ]);
  });

  it("hands the stored row back, and survives a listener that throws", () => {
    const item = store.createWorkItem({ title: "rude listener" });
    commentAttachments.setTodoAttachmentListener(() => { throw new Error("subscriber blew up"); });

    const row = attachments.addAttachment({ workItemId: item.id, filename: "kept.txt", mime: "text/plain",
      stagedPath: stage("kept"), uploader: OPERATOR });

    expect(attachments.getAttachment(row.id)?.filename).toBe("kept.txt");
  });
});
