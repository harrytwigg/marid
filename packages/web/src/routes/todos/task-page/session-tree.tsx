import { useNavigate } from "react-router-dom"
import { ArrowUpRight, CornerDownRight, Eye, MessageCircle } from "lucide-react"
import type { Employee } from "@/lib/api"
import type { SessionTreeNodeWire, SessionTreeWire } from "@/lib/session-tree-api"
import { pendingCaption, usePendingWork, type PendingWork } from "@/components/chat/pending-work"
import { SessionRef } from "./session-ref"

/**
 * The work a Todo caused, as a tree you can walk.
 *
 * The Todo page could show one session — a LIVE todo-dispatcher — and nothing
 * below it, while the real shape of in-flight work is a fan-out: the dispatcher
 * delegates, its delegates delegate, and a review hand-off is a delegation too.
 * All of that was in the database and none of it on the page.
 *
 * `role` is not decoration: the self-review ban means a reviewer session is
 * linked to a Todo it did NOT produce, so "who is on this" and "who did this"
 * are different questions and the tree has to answer both.
 */

const LIVE = new Set(["running", "waiting"])

/** Indent per level. Deliberately small: depth is capped at 6 server-side, so
 *  the deepest row still has room for a name on a narrow rail. */
const STEP = 14

/** A finished session is "Finished" only when nothing it left running can still
 *  change its answer. Otherwise the row says what it is waiting on, in the
 *  chat's own words, read from the same activity the chat reads. */
function StateLabel({ node }: { node: SessionTreeNodeWire }) {
  const pending = usePendingWork(node.backgroundActivity, node.delegatedActivity)
  return <>{stateLabel(node, pending)}</>
}

function stateLabel(node: SessionTreeNodeWire, pending: PendingWork | null): string {
  if (node.archived) return "Archived"
  if (LIVE.has(node.status ?? "")) return "Working"
  if (node.status === "error") return "Error"
  return pending ? pendingCaption(pending) : "Finished"
}

/** The badge that says this session is checking someone else's work, not doing
 *  its own. The self-review ban makes that a different kind of participation,
 *  so the tree has to show it rather than list one more indistinguishable row. */
function ReviewBadge({ id }: { id: string }) {
  return (
    <span
      data-testid={`session-tree-review-${id}`}
      title="Reviewing, not executing"
      className="flex flex-none items-center gap-1 rounded-[9px] bg-[var(--fill-tertiary)] px-[6px] py-[1px] text-[10.5px] font-medium text-[var(--text-tertiary)]"
    >
      <Eye size={9} aria-hidden />
      Review
    </span>
  )
}

/** The badge for a session a mention started: it was asked a question on this
 *  Todo, it did not take the Todo on. */
function ConsultBadge({ id }: { id: string }) {
  return (
    <span
      data-testid={`session-tree-consult-${id}`}
      title="Consulted, not executing"
      className="flex flex-none items-center gap-1 rounded-[9px] bg-[var(--fill-tertiary)] px-[6px] py-[1px] text-[10.5px] font-medium text-[var(--text-tertiary)]"
    >
      <MessageCircle size={9} aria-hidden />
      Consulted
    </span>
  )
}

/** The Todo a node minted, named only when it is not the page you are on. */
function NodeTodo({ id, todoId }: { id: string; todoId: string }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      data-testid={`session-tree-todo-${id}`}
      onClick={() => navigate(`/todos/${encodeURIComponent(todoId)}`)}
      className="focus-ring group/todo flex min-w-0 flex-none items-center gap-[3px] rounded-[5px] text-[11.5px] text-[var(--text-tertiary)] outline-none hover:text-[var(--text-secondary)]"
    >
      {todoId}
      <ArrowUpRight size={10} aria-hidden className="opacity-0 group-hover/todo:opacity-100" />
    </button>
  )
}

function TruncationNote({ id, reason, depth }: { id: string; reason: "depth" | "count"; depth: number }) {
  return (
    <div
      data-testid={`session-tree-truncated-${id}`}
      className="text-[11.5px] text-[var(--text-quaternary)]"
      style={{ paddingLeft: (depth + 1) * STEP }}
    >
      {reason === "depth" ? "Deeper work not shown" : "More work not shown"}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  byName,
  todoId,
}: {
  node: SessionTreeNodeWire
  depth: number
  byName: Map<string, Employee>
  todoId: string
}) {
  // The Todo a node tracks is worth naming only when it is NOT the one being
  // read — otherwise every row would repeat the page you are already on.
  const otherTodo = node.workItemId && node.workItemId !== todoId ? node.workItemId : null
  return (
    <>
      <div
        data-testid={`session-tree-node-${node.id}`}
        data-role={node.role}
        className="flex min-h-[28px] items-center gap-[7px] text-[13px]"
        style={{ paddingLeft: depth * STEP }}
      >
        {depth > 0 && <CornerDownRight size={11} aria-hidden className="flex-none text-[var(--text-quaternary)]" />}
        {node.role === "review" && <ReviewBadge id={node.id} />}
        {node.role === "consult" && <ConsultBadge id={node.id} />}
        <SessionRef sessionId={node.id} byName={byName} />
        <span className="flex-none text-[11.5px] text-[var(--text-quaternary)]"><StateLabel node={node} /></span>
        {otherTodo && <NodeTodo id={node.id} todoId={otherTodo} />}
      </div>
      {node.truncated && <TruncationNote id={node.id} reason={node.truncated.reason} depth={depth} />}
      {node.children.map((child) => (
        <TreeRow key={child.id} node={child} depth={depth + 1} byName={byName} todoId={todoId} />
      ))}
    </>
  )
}

export function SessionTreePanel({
  tree,
  byName,
  todoId,
}: {
  tree: SessionTreeWire | undefined
  byName: Map<string, Employee>
  todoId: string
}) {
  // A Todo nothing has worked reads exactly as it did before this existed: the
  // rail's Dispatch affordance and no empty region above it.
  if (!tree || tree.roots.length === 0) return null
  return (
    <div data-testid="session-tree" className="flex flex-col gap-[1px]">
      {tree.roots.map((node) => (
        <TreeRow key={node.id} node={node} depth={0} byName={byName} todoId={todoId} />
      ))}
      {tree.totals.nodes > 1 && (
        <div className="pt-1 text-[11.5px] text-[var(--text-quaternary)]" data-testid="session-tree-totals">
          {tree.totals.nodes} sessions{tree.totals.live > 0 ? ` · ${tree.totals.live} working` : ""}
        </div>
      )}
    </div>
  )
}
