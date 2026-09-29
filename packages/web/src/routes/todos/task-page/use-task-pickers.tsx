import { useCallback, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { selectionFeedback } from "@/platform"
import {
  api,
  ApiError,
  isPositiveTodoVersion,
  type DepartmentSummaryWire,
  type Employee,
  type VerifyModeWire,
  type WorkItemDetailWire,
  type WorkItemEditPatch,
  type WorkItemLabelWire,
  type WorkItemStatusWire,
} from "@/lib/api"
import { operatorSafeTodoError } from "@/lib/todos"
import type { CloseGateCounts } from "@/lib/legal-targets"
import { newTodoEditRequest, invalidateTodoCaches, saveTodoDetailRemote } from "../todo-edit-request"
import { useSetWorkItemStatus } from "../use-todos"
import { PickerPopover, PickerSheet } from "../pickers/picker-shell"
import {
  AssigneePickerContent,
  DepartmentPickerContent,
  DuePickerContent,
  LabelsPickerContent,
  PriorityPickerContent,
  VerifyPickerContent,
} from "../pickers/picker-contents"
import { StatusPickerContent } from "../pickers/status-picker-content"
import { offeredDepartments } from "../pickers/department-filters"

/* Todos v2 slice 6 — the task page's picker wiring: ONE picker open at a time,
 * one content component per property rendered in the popover shell (desktop —
 * superimposing its rail row, polish law 1) or the bottom-sheet shell (mobile
 * chips, law 4). Commits are optimistic; a server refusal snaps the value back
 * (cache invalidation) and surfaces the gateway's words via `announce`. */

export type PickerKey = "status" | "priority" | "assignee" | "labels" | "due" | "department" | "verify"

const PICKER_TITLE: Record<PickerKey, string> = {
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  labels: "Labels",
  due: "Due date",
  department: "Department",
  verify: "Review policy",
}

const PRIORITY_ORDER = [3, 2, 1, 0]

export function useTaskPickers({
  detail,
  employees,
  departments,
  openChildren,
  openDescendants,
  escalatedDescendants,
  mobile,
  announce,
}: {
  detail: WorkItemDetailWire | undefined
  employees: Employee[]
  departments: DepartmentSummaryWire[]
  mobile: boolean
  announce: (message: string) => void
} & CloseGateCounts) {
  const qc = useQueryClient()
  const [openPicker, setOpenPicker] = useState<PickerKey | null>(null)
  const id = detail?.workItem.id

  const close = useCallback(() => setOpenPicker((current) => {
    // Esc/commit returns focus to the anchor row (§7.3 keyboard contract).
    if (current) queueMicrotask(() => document.querySelector<HTMLElement>(`[data-testid="rail-${current}"]`)?.focus())
    return null
  }), [])

  // ── Commit lanes ──────────────────────────────────────────────────────────

  const setStatus = useSetWorkItemStatus()
  const transitionTo = useCallback(
    (status: WorkItemStatusWire, options?: { cascade?: boolean }) => {
      if (!id) return
      // On the gesture, not in onSuccess: the row already moves optimistically,
      // so a tap that waited for the round trip would trail its own animation.
      selectionFeedback()
      // Optimistic: the row shows the new value immediately; useSetWorkItemStatus
      // invalidates on settle so the server's truth reasserts either way.
      qc.setQueryData<WorkItemDetailWire>(["work-item", id], (current) =>
        current ? { ...current, workItem: { ...current.workItem, status } } : current,
      )
      setStatus.mutate(
        { id, status, cascade: options?.cascade },
        {
          // The board's refusal idiom: mapped safe copy where a code exists,
          // otherwise the gateway's own words for a typed API refusal.
          onError: (error) =>
            announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : "The gateway refused the move")),
        },
      )
    },
    [id, qc, setStatus, announce],
  )

  const patchField = useCallback(
    (patch: WorkItemEditPatch) => {
      if (!id || !detail) return
      const version = detail.workItem.version
      if (!isPositiveTodoVersion(version)) {
        announce("This Todo is missing an authoritative version — reload before editing.")
        return
      }
      qc.setQueryData<WorkItemDetailWire>(["work-item", id], (current) =>
        current ? { ...current, workItem: { ...current.workItem, ...patch } } : current,
      )
      void saveTodoDetailRemote(qc, id, newTodoEditRequest(patch, version)).catch((error) => {
        announce(operatorSafeTodoError(error, "Couldn't save this Todo"))
        void invalidateTodoCaches(qc, id)
      })
    },
    [id, detail, qc, announce],
  )

  /** Granting ownership is the assign lane's alone — roster check, backlog→assigned,
   *  live notify; the pen is the one lane that can clear it. Peek ships the same split. */
  const commitAssignee = useCallback((assignee: string | null) => {
    if (!id || assignee === null) return patchField({ assignee })
    qc.setQueryData<WorkItemDetailWire>(["work-item", id], (current) => (current ? { ...current, workItem: { ...current.workItem, assignee } } : current))
    api.assignWorkItem(id, assignee)
      .catch((error) => announce(operatorSafeTodoError(error, "Couldn't assign this Todo")))
      .finally(() => void invalidateTodoCaches(qc, id))
  }, [id, qc, announce, patchField])

  const labelsMutation = useMutation({
    mutationFn: ({ labels }: { labels: string[] }) => api.setWorkItemLabels(id!, labels),
    onError: (error) => announce(operatorSafeTodoError(error, "Couldn't update the labels")),
    onSettled: () => { if (id) void invalidateTodoCaches(qc, id) },
  })
  const commitLabels = useCallback(
    (labelIds: string[]) => {
      if (!id || !detail) return
      // Optimistic chips from the registry cache; the settle invalidation
      // reasserts the server's set either way.
      const registry = qc.getQueryData<WorkItemLabelWire[]>(["labels"]) ?? []
      const chosen = registry.filter((label) => labelIds.includes(label.id))
      qc.setQueryData<WorkItemDetailWire>(["work-item", id], (current) =>
        current ? { ...current, labels: chosen } : current,
      )
      labelsMutation.mutate({ labels: labelIds })
    },
    [id, detail, qc, labelsMutation],
  )

  const commitVerify = useCallback(
    (policy: { mode: VerifyModeWire; maxRounds: number } | null) => patchField({ verifyPolicy: policy }),
    [patchField],
  )

  // ── Shell assembly ────────────────────────────────────────────────────────

  const contentFor = useCallback(
    (key: PickerKey, sheet: boolean): React.ReactNode => {
      if (!detail) return null
      const shared = { detail, sheet, onDone: close }
      switch (key) {
        case "status":
          return (
            <StatusPickerContent
              {...shared}
              openChildren={openChildren}
              openDescendants={openDescendants}
              escalatedDescendants={escalatedDescendants}
              commit={transitionTo}
            />
          )
        case "priority":
          return <PriorityPickerContent {...shared} commit={(priority) => patchField({ priority })} />
        case "assignee":
          return <AssigneePickerContent {...shared} employees={employees} commit={commitAssignee} />
        case "labels":
          return <LabelsPickerContent {...shared} commit={commitLabels} />
        case "due":
          return <DuePickerContent {...shared} commit={(dueAt) => patchField({ dueAt })} />
        case "department":
          return <DepartmentPickerContent {...shared} departments={offeredDepartments(departments, detail.workItem.department)} commit={(department) => patchField({ department })} />
        case "verify":
          return <VerifyPickerContent {...shared} commit={commitVerify} />
      }
    },
    [detail, close, openChildren, openDescendants, escalatedDescendants, transitionTo, patchField, commitAssignee, employees, departments, commitLabels, commitVerify],
  )

  /** The superimposed row index (law 1): the current value's option row sits
   *  exactly over the anchor. Search/grid-led pickers align their top instead. */
  const currentIndexFor = useCallback(
    (key: PickerKey): number => {
      if (!detail) return 0
      const item = detail.workItem
      if (key === "priority") return Math.max(0, PRIORITY_ORDER.indexOf(item.priority))
      if (key === "department") {
        const offered = offeredDepartments(departments, item.department)
        const index = offered.findIndex((d) => d.slug === item.department)
        return index >= 0 ? index : offered.length // the "No department" row
      }
      return 0
    },
    [detail, departments],
  )

  const rowFor = useCallback(
    (key: PickerKey) => {
      if (!detail) return undefined
      return {
        onOpen: () => setOpenPicker((current) => (current === key ? null : key)),
        open: openPicker === key,
        // The same commit lane the picker's own Unassign row uses, so a surface
        // that clears in one tap and one that picks agree after a refetch.
        onClear: key === "assignee" && detail.workItem.assignee ? () => patchField({ assignee: null }) : undefined,
        picker:
          !mobile && openPicker === key ? (
            <PickerPopover
              key={key}
              label={PICKER_TITLE[key]}
              onClose={close}
              currentIndex={currentIndexFor(key)}
              autoFocusFirst={key !== "assignee"}
              testId={`picker-${key}`}
            >
              {contentFor(key, false)}
            </PickerPopover>
          ) : null,
      }
    },
    [detail, openPicker, mobile, close, currentIndexFor, contentFor, patchField],
  )

  /** The one mobile sheet (law 4) — rendered at page level via a portal. */
  const mobileSheet =
    mobile && openPicker && detail ? (
      <PickerSheet title={PICKER_TITLE[openPicker]} onClose={close} testId={`picker-sheet-${openPicker}`}>
        {contentFor(openPicker, true)}
      </PickerSheet>
    ) : null

  return { rowFor, mobileSheet, openPicker, setOpenPicker, transitionTo, patchField }
}
