import { Link } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"

export const NOT_SHARED = "This board isn't shared with you"

/** One answer for a board or Todo that is not theirs and one that does not exist: the gateway
 *  answers both with 404 so a member cannot probe which ids exist, and the page does not tell them apart either. */
export function BoardNotShared({ embedded = false }: { embedded?: boolean }) {
  const body = (
    <div data-testid="board-not-shared" className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <h1 className="text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">{NOT_SHARED}</h1>
      <p className="max-w-[340px] text-[14px] leading-[1.5] text-[var(--text-tertiary)]">
        Ask the person who invited you, or head back to the boards you can see.
      </p>
      <Link to="/" className="focus-outline rounded-full bg-[var(--fill-tertiary)] px-4 py-2 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
        Your boards
      </Link>
    </div>
  )
  return embedded ? body : <PageLayout>{body}</PageLayout>
}
