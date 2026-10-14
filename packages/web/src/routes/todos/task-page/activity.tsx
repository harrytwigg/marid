import { useEffect, useMemo, useRef, useState } from "react"
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUp, ChevronRight, FileText, Image as ImageIcon, Paperclip, X } from "lucide-react"
import {
  api,
  type Employee,
  type WorkItemAttachmentWire,
  type WorkItemCommentWire,
  type WorkItemDetailWire,
} from "@/lib/api"
import { commentAuthorLabel, operatorSafeTodoError } from "@/lib/todos"
import { MarkdownView } from "@/components/markdown-view"
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { useMentionPicker } from "@/components/mention-picker"
import { invalidateTodoComments, useAddTodoComment } from "../use-todo-comment"
import { commentHeadRequest, mergeCommentPages } from "./comment-window"
import { displayNameOf, formatRelativeTime } from "../util"
import { AttachmentChips } from "./comment-attachments"
import { CommentSessionLink, SessionActor } from "./session-ref"
import { WhisperLine } from "./whisper"
import { buildFeed, stripCommentMarkers } from "./activity-feed"
import { RunEndLine, RunStartLine } from "./runs"

/* The merged activity feed keeps audit events quiet and comment voices
 * prominent. Long comments collapse independently to a clamped preview; the
 * preview renders the same Markdown as the expanded body so links stay
 * clickable while collapsed. The same multiline composer docks at the thread
 * edge on desktop and mobile. */

export const COMMENT_COLLAPSE_THRESHOLD = 320

/** Operator comments avatar as the reserved "operator" actor, not an employee. */
function avatarFor(comment: WorkItemCommentWire): string {
  return comment.authorKind === "operator" ? "operator" : comment.author
}

function commentAuthor(comment: WorkItemCommentWire, byName: Map<string, Employee>): React.ReactNode {
  if (comment.authorKind === "operator") return "You"
  const label = comment.authorKind === "employee" ? displayNameOf(comment.author, byName) : commentAuthorLabel(comment.author, comment.authorKind)
  return <SessionActor actor={comment.author} byName={byName}>{label}</SessionActor>
}

function CommentBlock({
  comment,
  byName,
  isDark,
  attachments,
  workItemId,
  reply,
  repliedTo,
  onReply,
  onEdit,
  onDelete,
  busy,
}: {
  comment: WorkItemCommentWire
  byName: Map<string, Employee>
  isDark: boolean
  attachments: WorkItemAttachmentWire[]
  workItemId: string
  reply?: boolean
  /** The comment this one answered when the gateway flattened the thread to its
   *  root; set only when that differs from the root and is loaded. */
  repliedTo?: WorkItemCommentWire
  onReply?: () => void
  /** Operator-authored comments edit in place (gateway-enforced authority). */
  onEdit?: (body: string) => void
  /** The operator's surface deletes anything; tombstones keep shape. */
  onDelete?: () => void
  busy?: boolean
}) {
  const tombstoned = comment.deletedAt !== null
  const collapsible = !tombstoned && comment.body.length > COMMENT_COLLAPSE_THRESHOLD
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  return (
    <div className={`pb-0.5 pt-2 ${reply ? "ml-[30px]" : ""}`} data-testid={`activity-comment-${comment.id}`}>
      <div className="flex items-center gap-2">
        <EmployeeAvatar name={avatarFor(comment)} fallback={comment.authorKind === "operator" ? OPERATOR_DEFAULT_EMOJI : undefined} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
        <span className="text-[12.5px] font-semibold text-[var(--text-secondary)]">{commentAuthor(comment, byName)}</span>
        <span className="text-[10.5px] text-[var(--text-quaternary)]">{formatRelativeTime(comment.createdAt)}</span>
        {comment.editedAt && !tombstoned && <span className="text-[10.5px] text-[var(--text-quaternary)]">(edited)</span>}
        <CommentSessionLink sessionId={comment.sessionId} byName={byName} />
      </div>
      {repliedTo && (
        <div data-testid={`activity-replied-to-${comment.id}`} className="ml-[26px] mt-[3px] pl-3 text-[11.5px] text-[var(--text-quaternary)]">
          ↪ replying to {commentAuthor(repliedTo, byName)}
        </div>
      )}
      {editing ? (
        <div className="ml-[38px] mt-[5px]">
          <textarea
            autoFocus
            data-testid={`activity-edit-${comment.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="w-full min-w-0 resize-y rounded-[10px] bg-[var(--fill-quaternary)] p-2.5 text-[14.5px] text-[var(--text-primary)] outline-none"
          />
          <div className="mt-1 flex gap-3.5 text-[11.5px] font-medium text-[var(--text-quaternary)]">
            <button
              type="button"
              data-testid={`activity-edit-save-${comment.id}`}
              disabled={busy || !draft.trim()}
              onClick={() => {
                setEditing(false)
                if (draft.trim() && draft !== comment.body) onEdit?.(draft)
              }}
              className="focus-ring inline-flex items-center rounded outline-none hover:text-[var(--text-secondary)] disabled:opacity-50 max-[700px]:min-h-[34px]"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="focus-ring inline-flex items-center rounded outline-none hover:text-[var(--text-secondary)] max-[700px]:min-h-[34px]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="relative ml-[26px] mt-[5px] pl-3 text-[14.5px] leading-[1.5]">
          <span
            aria-hidden
            className={`absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px] ${
              comment.authorKind === "operator"
                ? "bg-[color-mix(in_srgb,var(--accent)_42%,transparent)]"
                : "bg-[var(--fill-primary)]"
            }`}
          />
          {tombstoned ? (
            <span className="italic text-[var(--text-quaternary)]">[deleted]</span>
          ) : collapsible && !expanded ? (
            <div
              data-testid={`activity-preview-${comment.id}`}
              className="line-clamp-3 break-words text-[var(--text-tertiary)] [&_.jinn-markdown]:text-[var(--text-tertiary)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            >
              <MarkdownView content={stripCommentMarkers(comment.body)} isDark={isDark} density="compact" mentions employees={byName} />
            </div>
          ) : (
            <MarkdownView content={stripCommentMarkers(comment.body)} isDark={isDark} density="compact" mentions employees={byName} />
          )}
          {collapsible && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
              className="focus-ring mt-1 flex min-h-[34px] items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
            >
              {expanded ? "Show less" : "Show more"}
              <ChevronRight
                size={11}
                strokeWidth={2.2}
                aria-hidden
                className={`transition-transform duration-150 ${expanded ? "-rotate-90" : "rotate-90"}`}
              />
            </button>
          )}
        </div>
      )}
      <AttachmentChips attachments={attachments} workItemId={workItemId} />
      {!tombstoned && !editing && (
        <div className="ml-[38px] mt-0.5 flex gap-3.5 text-[11.5px] font-medium text-[var(--text-quaternary)]">
          {onReply && (
            <button type="button" data-testid={`activity-reply-${comment.id}`} onClick={onReply} className="focus-ring inline-flex items-center rounded outline-none hover:text-[var(--text-secondary)] max-[700px]:min-h-[34px]">
              Reply
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              data-testid={`activity-edit-start-${comment.id}`}
              disabled={busy}
              onClick={() => {
                setDraft(comment.body)
                setEditing(true)
              }}
              className="focus-ring inline-flex items-center rounded outline-none hover:text-[var(--text-secondary)] disabled:opacity-50 max-[700px]:min-h-[34px]"
            >
              Edit
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              data-testid={`activity-delete-${comment.id}`}
              disabled={busy}
              onClick={onDelete}
              className="focus-ring inline-flex items-center rounded outline-none hover:text-[var(--text-secondary)] disabled:opacity-50 max-[700px]:min-h-[34px]"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Pending composer files (local UI until send attaches them). */
interface PendingFile {
  key: string
  file: File
}

export function ActivitySection({
  detail,
  byName,
  mobile,
  isDark = true,
  announce,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  mobile: boolean
  isDark?: boolean
  announce: (message: string) => void
}) {
  const qc = useQueryClient()
  const id = detail.workItem.id
  const head = commentHeadRequest(detail.comments)
  // Unseeded: skipToken means a short thread never refetches, so a seed would freeze at first paint and outlive a delete.
  const commentsQuery = useQuery({
    queryKey: ["work-item-comments", id],
    queryFn: head ? () => api.listWorkItemComments(id, head) : skipToken,
    staleTime: 10_000,
  })
  const attachmentsQuery = useQuery({
    queryKey: ["work-item-attachments", id],
    queryFn: async () => (await api.listWorkItemAttachments(id)).attachments,
    staleTime: 10_000,
  })
  const attachmentsByComment = useMemo(() => {
    const map = new Map<string, WorkItemAttachmentWire[]>()
    for (const attachment of attachmentsQuery.data ?? []) {
      if (!attachment.commentId) continue
      const list = map.get(attachment.commentId) ?? []
      list.push(attachment)
      map.set(attachment.commentId, list)
    }
    return map
  }, [attachmentsQuery.data])

  const comments = useMemo(() => mergeCommentPages(commentsQuery.data, detail.comments), [commentsQuery.data, detail.comments])
  const commentsById = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments])
  const repliedToOf = (comment: WorkItemCommentWire) =>
    comment.repliedToId && comment.repliedToId !== comment.parentCommentId
      ? commentsById.get(comment.repliedToId)
      : undefined
  const blocks = useMemo(
    () => buildFeed(detail.events, comments, detail.runs ?? []).reverse(),
    [detail.events, comments, detail.runs],
  )

  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState("")
  const [replyTo, setReplyTo] = useState<WorkItemCommentWire | null>(null)
  const [pending, setPending] = useState<PendingFile[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const invalidate = () => invalidateTodoComments(qc, id)

  const send = useAddTodoComment(id)
  const allEmployees = useMemo(() => [...byName.values()], [byName])
  const picker = useMentionPicker({ value: draft, setValue: setDraft, employees: allEmployees, textareaRef: composerRef })

  // Comment edit/delete carried over from the retired sheet (stage-B review
  // disposition b): edit only what the operator authored, delete anything —
  // the gateway enforces the same authority server-side.
  const editComment = useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
      api.editWorkItemComment(id, commentId, body),
    onError: (error) => announce(operatorSafeTodoError(error, "Couldn't save the comment")),
    onSettled: invalidate,
  })
  const removeComment = useMutation({
    mutationFn: (commentId: string) => api.deleteWorkItemComment(id, commentId),
    onError: (error) => announce(operatorSafeTodoError(error, "Couldn't delete the comment")),
    onSettled: invalidate,
  })
  const commentBusy = editComment.isPending || removeComment.isPending
  const commentActions = (comment: WorkItemCommentWire) => ({
    onEdit:
      comment.authorKind === "operator"
        ? (body: string) => editComment.mutate({ commentId: comment.id, body })
        : undefined,
    onDelete: () => removeComment.mutate(comment.id),
    busy: commentBusy,
  })

  const submit = () => {
    const body = draft.trim()
    if (!body || send.isPending) return
    send.mutate({ body, parentCommentId: replyTo?.id, files: pending.map((p) => p.file) }, {
      onSuccess: () => {
        setDraft("")
        setReplyTo(null)
        setPending([])
      },
      onError: (error) => announce(operatorSafeTodoError(error, "Couldn't post the comment")),
    })
  }
  useEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`
  }, [draft])
  const stageFiles = (files: File[]) => {
    setPending((current) => [
      ...current,
      ...files.map((file) => ({ key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file })),
    ])
  }

  const pendingChips = pending.length > 0 && (
    <div className="flex flex-wrap gap-2" data-testid="composer-pending">
      {pending.map((entry) => (
        <span
          key={entry.key}
          className="relative flex h-10 items-center gap-2 rounded-[10px] bg-[var(--fill-secondary)] pl-2 pr-3 text-[12.5px] font-medium text-[var(--text-primary)] shadow-[var(--shadow-ambient)]"
        >
          <span className="grid size-6 place-items-center rounded-[7px] bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]">
            {entry.file.type.startsWith("image/") ? <ImageIcon size={12} aria-hidden /> : <FileText size={12} aria-hidden />}
          </span>
          <span className="max-w-40 truncate">{entry.file.name}</span>
          <button
            type="button"
            aria-label={`Remove ${entry.file.name}`}
            onClick={() => setPending((current) => current.filter((candidate) => candidate.key !== entry.key))}
            className="absolute -right-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] shadow-[var(--shadow-subtle)]"
          >
            <X size={10} strokeWidth={2.4} aria-hidden />
          </button>
        </span>
      ))}
    </div>
  )

  const replyRow = replyTo && (
    <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
      Replying to {commentAuthor(replyTo, byName)}
      <button
        type="button"
        onClick={() => setReplyTo(null)}
        className="focus-ring rounded-full px-1.5 font-semibold text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-tertiary)]"
      >
        Cancel
      </button>
    </div>
  )

  const inputProps = {
    value: draft,
    onChange: picker.onChange,
    onSelect: picker.onSelect,
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (picker.onKeyDown(e)) return
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.files]
      if (files.length > 0) {
        e.preventDefault()
        stageFiles(files)
      }
    },
    "aria-label": replyTo ? "Reply" : "Add a comment",
    "data-testid": "composer-input",
  }

  const composerCore = (
    <div className="rounded-[22px] bg-[var(--bg-secondary)] p-3 shadow-[var(--shadow-card)]">
      {pendingChips && <div className="mb-[9px]">{pendingChips}</div>}
      {replyRow}
      <div className="relative">
        {picker.list}
        <textarea
          {...inputProps}
          ref={composerRef}
          rows={2}
          placeholder={replyTo ? "Reply…" : mobile ? "Comment" : "Comment…  ⇧↩ for a new line"}
          className="max-h-36 min-h-12 w-full resize-none overflow-y-auto bg-transparent px-1 text-[15px] leading-[1.5] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
        />
      </div>
      <div className="mt-1 flex min-h-[34px] items-center gap-2">
        <button
          type="button"
          aria-label="Attach"
          data-testid="composer-attach"
          onClick={() => fileRef.current?.click()}
          className="focus-ring grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-secondary)]"
        >
          <Paperclip size={15} strokeWidth={2} aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-quaternary)] max-[700px]:hidden">
          ↩ to send · ⇧↩ new line · markdown
        </span>
        <button
          type="button"
          aria-label="Send"
          data-testid="composer-send"
          disabled={send.isPending || !draft.trim()}
          onClick={submit}
          className="focus-ring grid size-[34px] flex-none place-items-center rounded-full outline-none disabled:opacity-40"
          style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
        >
          <ArrowUp size={15} strokeWidth={2.2} aria-hidden />
        </button>
      </div>
    </div>
  )

  /* The mobile composer uses the same card anatomy as desktop, fixed above
   * the safe area while the task-page takeover hides the tab bar. */
  const mobileBar = (
    <div
      data-testid="task-composer-mobile"
      className="fixed inset-x-0 bottom-0 z-20 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5"
      style={{
        background: "linear-gradient(to bottom, transparent, var(--bg) 18%)",
      }}
    >
      {composerCore}
    </div>
  )

  return (
    <div data-testid="task-activity">
      <div
        className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        Activity
      </div>
      <div>
        {blocks.map((block) => {
          if (block.kind === "comment") {
            return (
              <div key={`comment-${block.node.comment.id}`}>
                <CommentBlock
                  comment={block.node.comment}
                  byName={byName}
                  isDark={isDark}
                  attachments={attachmentsByComment.get(block.node.comment.id) ?? []}
                  workItemId={id}
                  repliedTo={repliedToOf(block.node.comment)}
                  onReply={() => setReplyTo(block.node.comment)}
                  {...commentActions(block.node.comment)}
                />
                {block.node.replies.map((replyComment) => (
                  <CommentBlock
                    key={replyComment.id}
                    comment={replyComment}
                    byName={byName}
                    isDark={isDark}
                    attachments={attachmentsByComment.get(replyComment.id) ?? []}
                    workItemId={id}
                    reply
                    repliedTo={repliedToOf(replyComment)}
                    // The gateway flattens this to the thread root and records the comment answered.
                    onReply={() => setReplyTo(replyComment)}
                    {...commentActions(replyComment)}
                  />
                ))}
              </div>
            )
          }
          if (block.kind === "event") return <WhisperLine key={`event-${block.event.id}`} event={block.event} byName={byName} />
          if (block.kind === "run-start") return <RunStartLine key={`run-start-${block.run.id}`} run={block.run} />
          if (block.kind === "run-end") {
            return <RunEndLine key={`run-end-${block.run.id}`} run={block.run} outcome={block.outcome} at={block.at} />
          }
          const foldId = block.events[0].id
          const open = openFolds.has(foldId)
          return (
            <div key={`fold-${foldId}`}>
              <button
                type="button"
                data-testid={`activity-fold-${foldId}`}
                aria-expanded={open}
                onClick={() =>
                  setOpenFolds((current) => {
                    const next = new Set(current)
                    if (next.has(foldId)) next.delete(foldId)
                    else next.add(foldId)
                    return next
                  })
                }
                className="focus-ring flex items-center py-1.5 text-[12.5px] font-medium text-[var(--text-quaternary)] outline-none hover:text-[var(--text-secondary)] max-[700px]:min-h-[34px]"
              >
                <ChevronRight
                  size={11}
                  strokeWidth={2.2}
                  aria-hidden
                  className={`ml-0.5 mr-[16.5px] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                />
                {block.events.length} quiet updates
              </button>
              {open && block.events.slice().reverse().map((event) => <WhisperLine key={event.id} event={event} byName={byName} />)}
            </div>
          )
        })}
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        data-testid="composer-file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ""
          if (files.length > 0) stageFiles(files)
        }}
      />

      {/* Desktop sticks to the inner scroll edge; mobile owns the viewport
          bottom above the safe area. */}
      {!mobile ? (
        <div
          className="sticky bottom-0 z-10 -mx-2 mt-6 px-2 pb-5 pt-5"
          data-testid="task-composer"
          style={{ background: "linear-gradient(to bottom, transparent, var(--bg) 18%)" }}
        >
          {composerCore}
        </div>
      ) : (
        mobileBar
      )}
    </div>
  )
}
