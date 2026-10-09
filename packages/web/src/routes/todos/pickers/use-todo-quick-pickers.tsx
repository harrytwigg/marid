import { useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  ApiError,
  isPositiveTodoVersion,
  type Employee,
  type WorkItemDetailWire,
  type WorkItemStatusWire,
} from '@/lib/api'
import { TODO_WRITE_KEY } from '@/lib/query-keys'
import { operatorSafeTodoError } from '@/lib/todos'
import { closeGateCounts, type CloseGateCounts } from '@/lib/legal-targets'
import { PickerInline, PickerNote } from './picker-shell'
import { AssigneePickerContent } from './picker-contents'
import { StatusPickerContent } from './status-picker-content'
import {
  invalidateTodoCaches,
  mergeTodoIntoCaches,
  newTodoEditRequest,
  saveTodoDetailRemote,
} from '../todo-edit-request'
import { useSetWorkItemStatus } from '../use-todos'

/* Status and owner for the surface that is not the task page — the search
 * workbench. The shells and the picker contents are the task
 * page's own — one picker grammar for the whole app — so every guard, every
 * gated reason and every refusal string is the task page's too, by
 * construction. What lives here is only what those surfaces do differently: one
 * picker at a time out of two rather than seven, no live region to announce
 * into (each panel shows the refusal inline), a status menu of moves only
 * because these shells cover no anchor row to superimpose, and the child count
 * the close gate needs fetched on demand, because its detail payload
 * carries none. */

export type TodoQuickPickerKey = 'status' | 'assignee'

const PICKER_TITLE: Record<TodoQuickPickerKey, string> = { status: 'Status', assignee: 'Assignee' }

export interface TodoQuickPickerRow {
  onOpen: () => void
  open: boolean
  /** The picker itself, disclosed in flow beside its anchor row: the workbench
   *  scrolls its own body inside a modal that traps focus, which only an inline
   *  picker survives. */
  picker: ReactNode
}

/** The surface's one refusal line. `fromGateway` keeps the board/task idiom: a
 *  mapped safe copy where the error carries a known code, the gateway's own
 *  sentence otherwise. */
function useRefusal() {
  const [message, setMessage] = useState<string | null>(null)
  const show = useCallback((text: string) => setMessage(text), [])
  const clear = useCallback(() => setMessage(null), [])
  const fromGateway = useCallback((cause: unknown, fallback: string) => {
    setMessage(operatorSafeTodoError(cause, cause instanceof ApiError ? cause.message : fallback))
  }, [])
  return { message, show, clear, fromGateway }
}

export type Refusal = ReturnType<typeof useRefusal>

/** The close gate's pre-check: legalTargets() needs the sub-task counts or it
 *  offers a Done the gateway will refuse. Asked for only while it is needed, and
 *  a failed read is reported rather than counted as zero — defaulting to zero
 *  would enable a close the gateway is about to refuse and blame the write for
 *  a read that never landed. */
function useCloseGate(id: string | undefined, active: boolean) {
  const tree = useQuery({
    queryKey: ['work-item-tree', id ?? ''],
    queryFn: () => api.getWorkItemTree(id!),
    enabled: !!id && active,
    staleTime: 10_000,
  })
  // The whole subtree is in hand here, so the cascade row can name what it
  // closes rather than counting only the children one level down. Memoized
  // because the picker's content callback takes the counts as a dependency.
  const counts = useMemo(() => closeGateCounts(tree.data?.tree.root), [tree.data])
  return { counts, pending: tree.isPending, failed: tree.isError }
}

function useStatusLane(id: string | undefined, refusal: Refusal) {
  const setStatus = useSetWorkItemStatus()
  return useCallback((status: WorkItemStatusWire, options?: { cascade?: boolean }) => {
    if (!id) return
    refusal.clear()
    // The shared lane patches every cache that holds this Todo — whichever one
    // the calling surface reads — so its row moves before the request resolves.
    setStatus.mutate({ id, status, cascade: options?.cascade }, {
      onError: (cause) => refusal.fromGateway(cause, 'The gateway refused the move'),
    })
  }, [id, setStatus, refusal])
}

/** `/assign` takes a name and cannot express "nobody", so Unassign goes through
 *  the conditional edit lane the task page's own Unassign row uses. Both wear
 *  TODO_WRITE_KEY, which is what defers a live invalidation mid-write. */
type AssignVariables = { assignee: string } | { assignee: null; expectedVersion: number }

function useAssignLane(detail: WorkItemDetailWire | undefined, refusal: Refusal) {
  const qc = useQueryClient()
  const id = detail?.workItem.id

  const showAssignee = useCallback((assignee: string | null) => {
    if (!id) return
    // Both roots a Todo is read from here: the mention preview copy and the
    // canonical detail the task page and the search workbench hold. An absent
    // root is left absent — the updater returning `undefined` writes nothing.
    for (const root of ['work-item-preview', 'work-item']) {
      qc.setQueryData<WorkItemDetailWire>([root, id], (current) =>
        current ? { ...current, workItem: { ...current.workItem, assignee } } : current)
    }
  }, [qc, id])

  const assign = useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: async (variables: AssignVariables) => {
      if (variables.assignee === null) {
        await saveTodoDetailRemote(qc, id!, newTodoEditRequest({ assignee: null }, variables.expectedVersion))
        return
      }
      mergeTodoIntoCaches(qc, (await api.assignWorkItem(id!, variables.assignee)).workItem)
    },
    onMutate: (variables: AssignVariables) => {
      const previous = detail?.workItem.assignee ?? null
      showAssignee(variables.assignee)
      return { previous }
    },
    onError: (cause, _variables, context) => {
      showAssignee(context?.previous ?? null)
      refusal.fromGateway(cause, 'The gateway refused the assignment')
    },
    onSettled: () => {
      if (id) void invalidateTodoCaches(qc, id)
    },
  })

  return useCallback((assignee: string | null) => {
    if (!detail) return
    refusal.clear()
    if (assignee !== null) return assign.mutate({ assignee })
    const expectedVersion = detail.workItem.version
    if (!isPositiveTodoVersion(expectedVersion)) {
      refusal.show('This Todo is missing an authoritative version — open it full to unassign.')
      return
    }
    assign.mutate({ assignee: null, expectedVersion })
  }, [detail, assign, refusal])
}

/** Closing hands focus back to the row that opened the picker (§7.3 keyboard
 *  contract), once the picker has left the tree. */
function useCloseToAnchor(setOpen: Dispatch<SetStateAction<TodoQuickPickerKey | null>>, prefix: string) {
  return useCallback(() => {
    setOpen((current) => {
      if (current) {
        queueMicrotask(() => document.querySelector<HTMLElement>(`[data-testid="${prefix}-row-${current}"]`)?.focus())
      }
      return null
    })
  }, [setOpen, prefix])
}

function usePickerContent({ detail, employees, close, children, transitionTo, commitAssignee }: {
  detail: WorkItemDetailWire | undefined
  employees: Employee[]
  close: () => void
  children: { counts: CloseGateCounts; pending: boolean; failed: boolean }
  transitionTo: (status: WorkItemStatusWire, options?: { cascade?: boolean }) => void
  commitAssignee: (assignee: string | null) => void
}) {
  return useCallback((key: TodoQuickPickerKey): ReactNode => {
    if (!detail) return null
    const shared = { detail, onDone: close }
    if (key === 'assignee') {
      return <AssigneePickerContent {...shared} employees={employees} commit={commitAssignee} />
    }
    if (children.failed) {
      return (
        <PickerNote>
          This Todo's sub-tasks could not be read, so its moves cannot be checked against the close
          gate. Close the picker to try again, or open the Todo full to move it.
        </PickerNote>
      )
    }
    // Rows wait for the counts rather than offering a Done that may not be legal.
    if (children.pending) return <PickerNote>Checking sub-tasks…</PickerNote>
    return (
      <StatusPickerContent {...shared} {...children.counts} commit={transitionTo} showCurrent={false} />
    )
  }, [detail, close, employees, commitAssignee, children.pending, children.failed, children.counts, transitionTo])
}

/** One anchor row's contract: how to open it, whether it is open, and the
 *  picker to render beside it. */
function usePickerRows({ open, setOpen, ready, prefix, close, contentFor }: {
  open: TodoQuickPickerKey | null
  setOpen: Dispatch<SetStateAction<TodoQuickPickerKey | null>>
  /** The detail is loaded, so there is something for a picker to act on. */
  ready: boolean
  prefix: string
  close: () => void
  contentFor: (key: TodoQuickPickerKey) => ReactNode
}) {
  return useCallback((key: TodoQuickPickerKey): TodoQuickPickerRow => {
    const shared = {
      label: PICKER_TITLE[key],
      onClose: close,
      // The assignee picker's search field takes the focus instead.
      autoFocusFirst: key !== 'assignee',
      testId: `${prefix}-picker-${key}`,
    }
    const showing = ready && open === key
    return {
      onOpen: () => setOpen((current) => (current === key ? null : key)),
      open: open === key,
      picker: showing ? <PickerInline {...shared}>{contentFor(key)}</PickerInline> : null,
    }
  }, [open, setOpen, ready, prefix, close, contentFor])
}

export function useTodoQuickPickers({ detail, employees, prefix, onOpenChange }: {
  detail: WorkItemDetailWire | undefined
  employees: Employee[]
  /** Names this surface's own anchors and pickers: `<prefix>-row-<key>` is the
   *  anchor focus returns to, `<prefix>-picker-<key>` the picker itself. */
  prefix: string
  /** Told whenever a picker opens or closes, for a surface that has to stand
   *  down its own Escape or focus ring while one is up. */
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState<TodoQuickPickerKey | null>(null)
  const refusal = useRefusal()
  const id = detail?.workItem.id
  const children = useCloseGate(id, open === 'status')

  // A picker belongs to the Todo it was opened on. A surface that keeps one
  // instance of this hook across a changing selection — the search workbench,
  // whose list re-ranks itself when a debounced result set lands — would
  // otherwise leave the menu up and re-point it at whatever is selected now,
  // and the next Enter would write to a Todo nobody opened a picker for.
  useEffect(() => { setOpen(null) }, [id])
  const transitionTo = useStatusLane(detail?.workItem.id, refusal)
  const commitAssignee = useAssignLane(detail, refusal)
  const close = useCloseToAnchor(setOpen, prefix)
  const contentFor = usePickerContent({ detail, employees, close, children, transitionTo, commitAssignee })
  const rowFor = usePickerRows({ open, setOpen, ready: Boolean(detail), prefix, close, contentFor })

  // The surface above may own Escape and a Tab ring; while a picker is up it
  // has to stand down, so it needs to know.
  useEffect(() => onOpenChange?.(open !== null), [open, onOpenChange])


  // The refusal channel goes back out whole: a surface with a write of its own
  // (the workbench's comment) reports through the same one line these do.
  return { rowFor, refusal }
}
