import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "@/lib/api"
import { operatorSafeTodoError } from "@/lib/todos"
import { isTodoId, todoPath } from "@/lib/todo-id"
import { closeGateCounts } from "@/lib/legal-targets"
import { copyText } from "@/platform"
import { useDepartments } from "@/hooks/use-departments"
import { useTheme } from "@/routes/providers"
import { useEmployeesByName, useOrg, useSetWorkItemStatus, useTodoById } from "../use-todos"
import { useKeepWorkItem } from "../board/use-board"
import { parseBoardParam, boardPath, boardKey } from "../board/board-route"
import { departmentTitle } from "../board/board-switcher"
import { CrumbBar } from "./crumb-bar"
import { ancestorsOf, nodeOf, workingElapsed } from "./task-tree"
import { TaskTitle } from "./task-title"
import { TaskFrame, useOpenTodoInPlace } from "./task-frame"
import { TaskBanner } from "./banner"
import { PropsRail } from "./props-rail"
import { SessionDirectoryProvider } from "./session-ref"
import { useTodoSessions } from "./use-todo-sessions"
import { ChipCluster } from "./chip-cluster"
import { useTaskPickers } from "./use-task-pickers"
import { BodyEditor } from "./body-editor"
import { SubTasksSection } from "./subtasks"
import { useSubTaskMutations } from "./use-subtask-mutations"
import { AttachmentDropSurface, AttachmentsSection } from "./attachments"
import { useTaskAttachments } from "./use-task-attachments"
import { ActivitySection } from "./activity"
import { TaskEmpty, TaskPageSkeleton } from "./task-page-fallbacks"
import { Slot } from "@/contrib/slot"
import { AREAS } from "@/contrib/types"

/* Variant A reads like a work document: the editable spine is always present,
 * with a persistent property rail on wide screens and the same properties
 * following the document on mobile. The URL is still the Todo, and back
 * restores the list/board scroll position. */

const MOBILE_QUERY = "(max-width: 700px)"

function useIsTaskMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false),
  )
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

interface TaskRouteState {
  fromBoard?: string
  /** Opened from a mention: on a phone, the back chevron returns there rather than to a board. */
  returnBack?: boolean
  focusBannerReason?: boolean
  bannerExpected?: boolean
}

export default function TaskPage() {
  const { todoId } = useParams()
  return <TaskView todoId={todoId} />
}

/** The Todo itself: the task page's content, at its route or (`embedded`) as a tab of the chat
 *  layout, where opening another Todo opens it as a tab beside this one. */
export function TaskView({ todoId, embedded = false }: { todoId: string | undefined; embedded?: boolean }) {
  const id = isTodoId(todoId) ? todoId : null
  const navigate = useNavigate()
  const location = useLocation()
  const routeState = (location.state ?? {}) as TaskRouteState
  const mobile = useIsTaskMobile()
  const { theme } = useTheme()
  const isDark = useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme")
      if (attr) return attr !== "light"
    }
    return theme !== "light"
  }, [theme])

  const detailQuery = useTodoById(id)
  const detail = detailQuery.data ?? undefined
  const item = detail?.workItem
  const rootId = item?.rootId ?? id ?? ""
  const treeQuery = useQuery({
    queryKey: ["work-item-tree", rootId],
    queryFn: () => api.getWorkItemTree(rootId),
    enabled: !!item && !!rootId,
    staleTime: 10_000,
  })
  const rootNode = treeQuery.data?.tree.root
  const ancestors = useMemo(() => (id ? ancestorsOf(rootNode, id) : []), [rootNode, id])

  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const departments = useDepartments()

  // `treeQuery` above is the Todo relations tree; this one is the sessions working it.
  const { tree: sessionTree, hasLiveSession, railSession } = useTodoSessions(id)

  // ── Transient refusal callout — always the gateway's words; renders above the picker sheet, which is where the refusals it reports come from ──
  const [callout, setCallout] = useState<string | null>(null)
  const calloutTimer = useRef<number | null>(null)
  const announce = useCallback((message: string) => {
    setCallout(message)
    if (calloutTimer.current !== null) window.clearTimeout(calloutTimer.current)
    calloutTimer.current = window.setTimeout(() => setCallout(null), 6000)
  }, [])
  useEffect(() => () => {
    if (calloutTimer.current !== null) window.clearTimeout(calloutTimer.current)
  }, [])
  const copyId = useCallback(() => {
    if (!id) return
    void copyText(id).then((result) => {
      announce(result.status === "performed" ? `Copied ${id}` : "Couldn't copy the ID")
    })
  }, [id, announce])

  const setStatus = useSetWorkItemStatus()

  // ── Pickers (one open at a time; §7.3) ────────────────────────────────────
  const itemNode = useMemo(() => (id ? nodeOf(rootNode, id) : undefined), [rootNode, id])
  // Both halves of the close gate: the server weighs this item's DIRECT open
  // children, while a cascade Done closes every open descendant under them.
  const closeGate = useMemo(() => closeGateCounts(itemNode), [itemNode])
  const pickers = useTaskPickers({
    detail,
    employees: org.data?.employees ?? [],
    departments: departments.data ?? [],
    ...closeGate,
    mobile,
    announce,
  })

  // ── Section mutations (sub-tasks; attachments have their own hook) ──
  const qc = useQueryClient()
  const failWith = useCallback(
    (fallback: string) => (error: unknown) =>
      announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : fallback)),
    [announce],
  )
  const dispatchTodo = useMutation({
    mutationFn: () => api.dispatchTodo(id!),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["work-item-sessions", id ?? ""] })
      announce(result.reused ? "Dispatcher is already working" : "Dispatcher started")
    },
    onError: failWith("Couldn't start the Dispatcher"),
  })
  const { childStatus, childAssign, addSubTask } = useSubTaskMutations({ id, rootId, item, failWith })
  const attachments = useTaskAttachments({ id, enabled: !!item, onError: failWith, onUploadFailures: (filenames) => announce(`Couldn't attach ${filenames.join(", ")}`) })

  const commitBannerReason = useCallback(
    (note: string) => {
      if (!item) return
      setStatus.mutate(
        { id: item.id, status: item.status, note },
        {
          onError: (error) =>
            announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : "Couldn't save the reason")),
        },
      )
    },
    [item, setStatus, announce],
  )
  // ── Board context (the crumb's back affordance) ───────────────────────────
  const keep = useKeepWorkItem(announce)
  const boardKeyRaw = routeState.fromBoard ?? item?.department ?? "everything"
  const board = parseBoardParam(boardKeyRaw)
  const boardLabel = board.kind === "department" ? departmentTitle(board.slug)
    : board.kind === "attention" ? "Attention"
    : "Everything"
  const goBack = useCallback(() => {
    // Arriving from a board leaves it one POP away — going back that way
    // restores the board's cached scroll position. Otherwise push its path.
    if (routeState.fromBoard && window.history.length > 1) navigate(-1)
    // A phone's chevron says only "back", so it returns to the mention that opened it: an in-app
    // push, so there is always an entry to return to.
    else if (mobile && routeState.returnBack) navigate(-1)
    else navigate(boardPath(board))
  }, [routeState.fromBoard, routeState.returnBack, mobile, navigate, board])

  const openTodo = useOpenTodoInPlace(embedded, useCallback(
    (nextId: string) => navigate(todoPath(nextId), { state: { fromBoard: boardKey(board) } }),
    [navigate, board],
  ))

  const working = detail ? workingElapsed(detail) : null

  // ── Not found / loading ───────────────────────────────────────────────────
  if (!id) {
    return (
      <TaskFrame embedded={embedded}>
        <TaskEmpty message="That's not a Todo ID." onBack={() => navigate("/todos")} />
      </TaskFrame>
    )
  }
  if (detailQuery.isSuccess && detailQuery.data === null) {
    return (
      <TaskFrame embedded={embedded}>
        <TaskEmpty message={`${id} doesn't exist (anymore).`} onBack={() => navigate("/todos")} />
      </TaskFrame>
    )
  }
  // A transport/server failure is retryable — never masquerade as deletion
  // (only a canonical 404 means missing; useTodoById maps that to null).
  if (detailQuery.isError) {
    return (
      <TaskFrame embedded={embedded}>
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="task-load-error">
          <div className="text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">
            Couldn&rsquo;t load {id}.
          </div>
          <p className="max-w-[340px] text-[14px] leading-[1.5] text-[var(--text-tertiary)]">
            {operatorSafeTodoError(detailQuery.error, "The gateway didn't answer. It may be restarting.")}
          </p>
          <button
            type="button"
            data-testid="task-load-retry"
            onClick={() => void detailQuery.refetch()}
            className="focus-ring rounded-full px-4 py-2 text-[13px] font-semibold text-[var(--accent)] outline-none hover:bg-[var(--accent-fill)]"
          >
            Retry
          </button>
        </div>
      </TaskFrame>
    )
  }
  if (detailQuery.isPending) {
    return (
      <TaskFrame embedded={embedded} hideMobileTabBar={mobile}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="@container min-h-0 flex-1 overflow-y-auto" data-scrollable data-testid="task-page-scroll">
            <CrumbBar
              boardLabel={boardLabel}
              onBack={goBack}
              ancestors={[]}
              id={id}
              title=""
              onOpenAncestor={openTodo}
              onCopyId={copyId}
              mobile={mobile}
            />
            <div
              data-testid="task-page-grid"
              className={
                mobile
                  ? "flex flex-col px-4 pb-[calc(96px+var(--safe-bottom,0px))] pt-1.5"
                  : "mx-auto w-full max-w-[1080px] px-6 pb-8 pt-2 @2xl:px-10"
              }
            >
              <TaskPageSkeleton
                mobile={mobile}
                bannerExpected={routeState.bannerExpected ?? routeState.focusBannerReason ?? false}
              />
            </div>
          </div>
        </div>
      </TaskFrame>
    )
  }

  return (
    // Mobile is a full-screen push (§8): the tab bar yields the bottom edge to
    // the fixed comment bar; back is the condensed crumb's chevron.
    // The directory rides a context because the surfaces that resolve a session
    // id — rail, audit whisper, comment author — sit at unrelated depths.
    <SessionDirectoryProvider directory={sessionTree?.directory}>
    <TaskFrame embedded={embedded} hideMobileTabBar={mobile}>
      <AttachmentDropSurface className="flex h-full min-h-0 flex-col" onUpload={(files) => attachments.upload.mutate(files)}>
        <div className="@container min-h-0 flex-1 overflow-y-auto" data-scrollable data-testid="task-page-scroll">
          <CrumbBar
            boardLabel={boardLabel}
            onBack={goBack}
            kept={detail?.kept}
            onKeep={keep.mutate}
            ancestors={ancestors}
            id={id}
            title={item?.title ?? ""}
            onOpenAncestor={openTodo}
            onCopyId={copyId}
            mobile={mobile}
          />

          <div
            data-testid="task-page-grid"
            className={
              mobile
                ? "flex flex-col px-4 pb-[calc(96px+var(--safe-bottom,0px))] pt-1.5"
                : "mx-auto grid w-full max-w-[1080px] grid-cols-1 gap-x-9 px-6 pb-8 pt-2 @2xl:px-10 @4xl:grid-cols-[minmax(0,1fr)_260px]"
            }
          >
            {detail && (
              <div className={mobile ? "" : "@4xl:col-span-2"}>
                <TaskBanner
                    detail={detail}
                    byName={byName}
                    focusReason={!!routeState.focusBannerReason}
                    busy={setStatus.isPending}
                    onCommitReason={commitBannerReason}
                    actions={
                      detail.workItem.status === "blocked" ? (
                        <button
                          type="button"
                          data-testid="task-banner-unblock"
                          onClick={() => pickers.setOpenPicker("status")}
                          className="focus-ring min-h-8 rounded-full bg-[var(--fill-tertiary)] px-3 text-[12.5px] font-semibold text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-secondary)]"
                        >
                          Unblock…
                        </button>
                      ) : undefined
                    }
                  />
              </div>
            )}

            <main className="min-w-0">
              {mobile && (
                <button
                  type="button"
                  data-testid="task-copy-id-mobile"
                  aria-label={`Copy ${id}`}
                  onClick={copyId}
                  className="focus-ring relative -mx-1 mb-1 block w-fit rounded-md px-1 text-[12px] tracking-[.04em] text-[var(--text-tertiary)] outline-none after:absolute after:bottom-0 after:left-0 after:h-[34px] after:w-full after:content-[''] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
                  style={{ fontFamily: "var(--font-code)" }}
                >
                  {id}
                </button>
              )}

              <TaskTitle
                title={item?.title ?? null}
                mobile={mobile}
                onCommit={(title) => pickers.patchField({ title })}
              />

              {detail && (
                <ChipCluster
                  detail={detail}
                  byName={byName}
                  mobile={mobile}
                  working={hasLiveSession ? working : null}
                  rowFor={pickers.rowFor}
                />
              )}

              <div
                className="-mx-2 mt-7 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-[var(--fill-quaternary)] focus-within:bg-[var(--fill-quaternary)]"
                data-testid="task-body"
              >
                {item && (
                  <BodyEditor
                    body={item.body}
                    editable
                    isDark={isDark}
                    onCommit={(markdown) => pickers.patchField({ body: markdown })}
                  />
                )}
              </div>

              {item && (
                <>
                  <AttachmentsSection
                    attachments={attachments.files}
                    onUpload={(files) => attachments.upload.mutate(files)}
                    onRemove={(attachment) => attachments.remove.mutate(attachment)}
                  />
                  <SubTasksSection
                    node={itemNode}
                    parentDepth={item.depth ?? 0}
                    employees={org.data?.employees ?? []}
                    byName={byName}
                    mobile={mobile}
                    onOpenChild={openTodo}
                    onChildStatus={(childId, status, cascade) => childStatus.mutate({ childId, status, cascade })}
                    onChildAssign={(childId, assignee) => childAssign.mutate({ childId, assignee })}
                    onAddSubTask={(nextTitle) => addSubTask.mutate(nextTitle)}
                  />
                </>
              )}

              {/* Contributed sections close the document, after the app's own
                  sections and before the properties rail and Activity — the
                  same reading order a reviewer already walks. */}
              <Slot area={AREAS.todoDetailSections} variant="pane" className="mt-8 flex flex-col gap-4" />

              {mobile && detail && (
                <div className="mt-8 border-t border-[var(--separator)] pt-5">
                  <PropsRail
                    detail={detail}
                    byName={byName}
                    departments={departments.data}
                    rowFor={pickers.rowFor}
                    railSession={railSession}
                    sessionTree={sessionTree}
                    dispatchPending={dispatchTodo.isPending}
                    onDispatch={() => dispatchTodo.mutate()}
                    onOpenRailSession={(sessionId) => navigate(`/?session=${encodeURIComponent(sessionId)}`)}
                  />
                </div>
              )}

              {detail && (
                <ActivitySection
                  detail={detail}
                  byName={byName}
                  mobile={mobile}
                  isDark={isDark}
                  announce={announce}
                />
              )}
            </main>

            {!mobile && detail && (
              <aside className="min-w-0 pt-1 @4xl:sticky @4xl:top-3 @4xl:self-start">
                <PropsRail
                  detail={detail}
                  byName={byName}
                  departments={departments.data}
                  rowFor={pickers.rowFor}
                  railSession={railSession}
                  sessionTree={sessionTree}
                  dispatchPending={dispatchTodo.isPending}
                  onDispatch={() => dispatchTodo.mutate()}
                  onOpenRailSession={(sessionId) => navigate(`/?session=${encodeURIComponent(sessionId)}`)}
                />
              </aside>
            )}
          </div>
        </div>
      </AttachmentDropSurface>

      {pickers.mobileSheet}

      {callout && (
        <div
          role="status"
          data-testid="task-callout"
          className="pointer-events-none fixed bottom-6 left-1/2 z-[130] -translate-x-1/2 rounded-[var(--radius-lg)] bg-[var(--material-thick)] px-4 py-2.5 text-[length:var(--text-footnote)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        >
          {callout}
        </div>
      )}
    </TaskFrame>
    </SessionDirectoryProvider>
  )
}
