import { lazy, Suspense, useState } from "react"
import { MoreHorizontal } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS } from "@/components/chat/session-row-menu"
import type { ArchiveStage } from "./department-archive-dialog"

/* A department board's `⋯`: archive the department, or take it back. Archiving is
 * reversible and deletes nothing, but it stops anything new being filed there, so it
 * goes through a dialog. When the department still has members or open Todos the
 * gateway refuses the first ask and names them; the dialog shows that and the
 * operator confirms a second time. Un-archiving needs no second word. */

const ArchiveDialog = lazy(() => import("./department-archive-dialog").then((module) => ({ default: module.ArchiveDialog })))

const TRIGGER_CLASS =
  "focus-ring inline-flex size-10 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-ambient),var(--shadow-subtle),var(--inset-shine)] outline-none transition-transform hover:scale-[0.96] motion-reduce:transition-none"

export function DepartmentArchiveMenu({ slug, prefix, archived }: { slug: string; prefix: string | undefined; archived: boolean }) {
  const [stage, setStage] = useState<ArchiveStage | "closed">("closed")
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-testid="department-board-menu" aria-label="Department actions" className={TRIGGER_CLASS}>
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
          <DropdownMenuItem
            className={SESSION_MENU_ITEM_CLASS}
            data-testid={archived ? "department-unarchive" : "department-archive"}
            onSelect={() => setStage(archived ? "unarchive" : "archive")}
          >
            {archived ? "Un-archive department…" : "Archive department…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {stage !== "closed" && (
        <Suspense fallback={null}>
          <ArchiveDialog key={stage} slug={slug} prefix={prefix} stage={stage} onClose={() => setStage("closed")} />
        </Suspense>
      )}
    </>
  )
}
