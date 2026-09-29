import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useSettings } from "@/routes/settings-provider"
import type { QueryFacetWire, SearchKind } from "@/lib/search-api"
import { CommandList } from "./global-search/command-list"
import { CommandPane } from "./global-search/command-pane"
import { KIND_META } from "./global-search/kind-meta"
import { PreviewPane } from "./global-search/preview-pane"
import { QuickCreateTodo } from "./global-search/quick-create-todo"
import { ReadBackLine } from "./global-search/read-back-line"
import { ResultList } from "./global-search/result-list"
import { loadRecent, saveRecent, type RecentItem } from "./global-search/recents"
import { recentRows, resultRows, rowTarget, type SearchRow } from "./global-search/rows"
import { useCommandMode } from "./global-search/use-command"
import { useGlobalSearch } from "./global-search/use-global-search"
import { useSearchKeyboard } from "./global-search/use-search-keyboard"
import { useTodoWorkbench } from "./global-search/use-todo-workbench"
import { activatePrimary, commandFor, parseCommand, type Verb } from "./global-search/verbs"
import { PRODUCT_NAME } from "@/lib/brand"

// The palette stays a module rather than becoming `global-search/index.tsx`, so
// `import("./global-search")` and every `@/components/global-search` specifier
// keeps resolving to exactly this file. Its parts live in the sibling directory.
export { STATIC_PAGES, staticPagesFor } from "./global-search/static-pages"

const PALETTE = [
  "flex flex-col overflow-hidden p-0 gap-0 border-0",
  // `sm:max-w-lg` is in the dialog's own base class, so the wide cap needs the
  // same breakpoint to win — a bare max-width loses to it above 640px.
  "top-[88px] translate-y-0 w-[880px] max-w-[calc(100%-2rem)] sm:max-w-[880px] h-[560px]",
  "rounded-[var(--radius-2xl)] bg-[var(--material-thick)] shadow-[var(--shadow-overlay)]",
  "backdrop-blur-[40px] backdrop-saturate-[1.8]",
  "max-[480px]:top-0 max-[480px]:left-0 max-[480px]:translate-x-0",
  "max-[480px]:h-[100dvh] max-[480px]:w-full max-[480px]:max-w-full max-[480px]:rounded-none",
].join(" ")

const SCRIM = "bg-[var(--scrim)] backdrop-blur-[14px] backdrop-saturate-[1.2]"
const PILL = "inline-flex flex-none items-center gap-1.5 rounded-lg bg-[var(--accent-fill)] px-[9px] py-1 text-[13px] font-medium text-[var(--accent)]"
const FOOTER = "flex items-center gap-[15px] bg-[var(--material-thin)] px-5 py-[9px] text-[11.5px] text-[var(--text-quaternary)] max-[480px]:hidden"
const FOOTER_KEY = "font-medium text-[var(--text-tertiary)]"

export interface GlobalSearchProps {
  initialOpen?: boolean
  /** Opens narrowed to one kind, with a pill that widens it again. The Todos
   *  filter row opens the palette this way. */
  initialScope?: SearchKind
  /** Seeds the field, so the keystroke that opened the palette is not lost. */
  initialQuery?: string
}

export function GlobalSearch({ initialOpen = false, initialScope, initialQuery }: GlobalSearchProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? PRODUCT_NAME
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState(initialQuery ?? "")
  const [literal, setLiteral] = useState(false)
  const [scope, setScope] = useState<SearchKind | undefined>(initialScope)
  const [selected, setSelected] = useState(0)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const goTo = useNavigate()

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next)
    if (next) return
    setQuery("")
    setLiteral(false)
    setScope(initialScope)
  }, [initialScope])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "k") return
      e.preventDefault()
      changeOpen(!open)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, changeOpen])

  useEffect(() => { if (open) setRecents(loadRecent()) }, [open])

  // A leading ">" is the whole of the disambiguation: a plain query is never
  // parsed for verbs, so the search behind it cannot be taken over by one.
  const command = parseCommand(query)
  const typing = !command && query.trim().length > 0
  const search = useGlobalSearch({ query: command ? "" : query, scope, literal })
  const rows = useMemo(
    () => (typing ? resultRows(search.data?.results) : recentRows(recents)),
    [typing, search.data, recents],
  )
  const row = command ? undefined : rows[selected]
  const mode = useCommandMode(command, row, open)
  const verbs = mode?.command.matches ?? []
  // Both lists share the selection, so both have to reset it when their contents
  // change under it.
  const listKey = mode ? verbs.map(verb => verb.name).join(" ") : rows.map(item => item.key).join(" ")
  useEffect(() => { setSelected(0) }, [listKey])
  // The selected Todo's write half. Held here rather than in the preview because
  // the result row shows the same live status the preview does. One instance,
  // pointed at the list's selection in find mode and at the command's object in
  // command mode — so assign and move have exactly one implementation.
  const [pickerOpen, setPickerOpen] = useState(false)
  const workbench = useTodoWorkbench(mode ? mode.object : row, setPickerOpen)

  const activate = useCallback((target: SearchRow) => {
    const recent = rowTarget(target)
    saveRecent(recent)
    changeOpen(false)
    goTo(recent.href)
  }, [changeOpen, goTo])

  const toggleLiteral = useCallback(() => setLiteral(wasLiteral => !wasLiteral), [])

  const pickVerb = useCallback((verb: Verb) => setQuery(commandFor(verb)), [])

  /** `new` hands over to the board's own create dialog, which is a sibling of
   *  the palette rather than a child: the palette closes as it opens, and a
   *  dialog inside a closing one would go with it. */
  const [creating, setCreating] = useState<string | null>(null)
  const startNewTodo = useCallback((title: string) => {
    setCreating(title)
    changeOpen(false)
  }, [changeOpen])

  /** Facet spans index the query the gateway parsed, so that is what is cut. */
  const removeFacet = useCallback((facet: QueryFacetWire) => {
    const base = search.data?.query ?? query
    setQuery(`${base.slice(0, facet.span.start)}${base.slice(facet.span.end)}`.replace(/\s+/g, " ").trim())
  }, [search.data, query])

  const handleKeyDown = useSearchKeyboard({
    rowCount: mode ? verbs.length : rows.length,
    selectedIndex: selected,
    onMove: setSelected,
    onActivate: () => {
      if (!mode) {
        if (row) activate(row)
        return
      }
      // A committed verb has a form; ⏎ hands the field over to it rather than
      // re-picking the verb that is already on screen.
      if (mode.verb) activatePrimary(mode.verb)
      else if (verbs[selected]) pickVerb(verbs[selected])
    },
    onToggleLiteral: toggleLiteral,
  })

  const loading = typing && search.isFetching && !search.data
  const hint = typing
    ? "Nothing matched. Try fewer words, or search literally."
    : "Type to search Todos, chats, notes, people, cron and skills. Press > for commands — assign, move, run, new."

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className={PALETTE}
          overlayClassName={SCRIM}
          showCloseButton={false}
          aria-describedby={undefined}
          onEscapeKeyDown={event => {
            // A workbench picker owns Escape while it is up. Radix registers this
            // handler in the same capture phase the picker's own listener runs in,
            // so the picker's stopPropagation() cannot reach it — the overlay has
            // to stand down here instead, or one Escape closes the picker AND
            // throws the query away with it.
            if (pickerOpen) {
              event.preventDefault()
              return
            }
            if (!query) return
            event.preventDefault()
            setQuery("")
          }}
          onKeyDown={handleKeyDown}
        >
          {/* Radix requires an accessible title; the field is the visible one. */}
          <DialogTitle className="sr-only">Search {portalName}</DialogTitle>

          <div className="flex items-center gap-[11px] px-5 pb-[15px] pt-[17px] max-[480px]:px-4 max-[480px]:pb-3 max-[480px]:pt-3.5">
            <Search size={18} aria-hidden="true" className="flex-none text-[var(--text-tertiary)]" />
            {scope && (
              <button type="button" data-testid="search-scope-pill" onClick={() => setScope(undefined)} className={PILL}>
                {KIND_META[scope].plural}
                <span aria-hidden="true" className="opacity-55">&times;</span>
                <span className="sr-only">Search everything instead</span>
              </button>
            )}
            <input
              autoFocus
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={`Search ${portalName}`}
              aria-label={`Search ${portalName}`}
              className="min-w-0 flex-1 bg-transparent text-[21px] tracking-[-0.012em] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] max-[480px]:text-[19px]"
            />
            <span className="flex-none rounded-md bg-[var(--fill-tertiary)] px-[7px] py-[3px] text-[11px] font-medium text-[var(--text-tertiary)]">esc</span>
          </div>

          {search.data && (
            <ReadBackLine parsed={search.data.parsed} onRemoveFacet={removeFacet} onToggleLiteral={toggleLiteral} />
          )}

          <div className="flex min-h-0 flex-1 max-[480px]:flex-col">
            <div className="w-[396px] flex-none overflow-y-auto px-[10px] pb-[10px] pt-0.5 max-[480px]:w-full max-[480px]:flex-1 max-[480px]:px-2">
              {mode ? (
                <CommandList verbs={verbs} selectedIndex={selected} onSelect={setSelected} onPick={pickVerb} />
              ) : (
                <ResultList
                  rows={rows}
                  selectedIndex={selected}
                  onSelect={setSelected}
                  onActivate={activate}
                  emptyLabel={typing ? "No results" : "Nothing opened from here yet"}
                  loading={loading}
                  selectedStatus={workbench?.status}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--material-thin)] max-[480px]:max-h-[55%] max-[480px]:flex-none max-[480px]:rounded-t-[var(--radius-2xl)] max-[480px]:bg-[var(--material-thick)] max-[480px]:pt-2.5 max-[480px]:pb-[max(18px,env(safe-area-inset-bottom))] max-[480px]:shadow-[var(--shadow-overlay)]">
              <div aria-hidden="true" className="mx-auto mb-3.5 hidden h-[5px] w-9 rounded-[3px] bg-[var(--fill-primary)] max-[480px]:block" />
              {mode ? (
                <CommandPane mode={mode} workbench={workbench} onCreateTodo={startNewTodo} />
              ) : (
                <PreviewPane
                  row={row}
                  error={search.error}
                  hint={hint}
                  literal={literal}
                  onSearchLiterally={toggleLiteral}
                  workbench={workbench}
                />
              )}
            </div>
          </div>

          <div className={FOOTER}>
            <span><b className={FOOTER_KEY}>&#8593;&#8595;</b> navigate</span>
            <span><b className={FOOTER_KEY}>&#9166;</b> open</span>
            <span><b className={FOOTER_KEY}>&#8984;&#9166;</b> search literally</span>
            <span><b className={FOOTER_KEY}>&gt;</b> commands</span>
          </div>
        </DialogContent>
      </Dialog>
      {creating !== null && <QuickCreateTodo title={creating} onDone={() => setCreating(null)} />}
    </>
  )
}
