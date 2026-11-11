import { useCallback, useEffect, useRef, useState } from "react"
import { Filter, MoreHorizontal } from "@/components/ui/icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { useSearchOverlay } from "@/components/search-overlay-context"
import type { Employee } from "@/lib/api"
import { activeFilterCount, type TodoFilters } from "@/lib/todos"
import { DATE_OPTIONS, DUE_OPTIONS, SOURCE_OPTIONS, STATUS_OPTIONS } from "./filter-options"
import { useLabelRegistry } from "./use-todos"
import { sprintFilterLabel, useSprints } from "./sprints/use-sprints"
import { SprintFilterItems } from "./sprints/sprint-filter-items"
import { SearchLauncher } from "./search-launcher"
import { LazyTodoFilterSheet } from "./todo-filter-sheet-lazy"
import { agentFilterLabel, UNASSIGNED_FILTER } from "./util"
import { personFilterLabel, usePersonFilterChoices, type PersonFilterChoices } from "./person-filter"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { memberIdentity } from "@/lib/accounts-api"
import { OPERATOR_ASSIGNEE } from "./util"
import { ActiveChip, BoardActiveChip, MenuCheck, SUBMENU_CLASS, ValueChip } from "./filter-chips"

const MENU_CLASS =
  "w-[min(320px,calc(100vw-24px))] rounded-[var(--radius-xl)] p-2"
const ITEM_CLASS =
  "min-h-11 cursor-pointer rounded-[10px] px-3 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"

const MOBILE_QUERY = "(max-width: 767px)"

function useIsTodoMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false))
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

/** The Person filter's rows: Anyone, Me, No person, then the people with access to the board. Shared by the board chip and the
 *  refine menu. */
function PersonItems({ filters, onChange, choices }: { filters: TodoFilters; onChange: (next: TodoFilters) => void; choices: PersonFilterChoices }) {
  const pick = (person: string | undefined) => () => onChange({ ...filters, person })
  return (
    <>
      <DropdownMenuItem className={ITEM_CLASS} onClick={pick(undefined)}>
        Anyone<MenuCheck on={!filters.person} />
      </DropdownMenuItem>
      <DropdownMenuItem className={ITEM_CLASS} onClick={pick(choices.me)}>
        Me<MenuCheck on={filters.person === choices.me} />
      </DropdownMenuItem>
      <DropdownMenuItem className={ITEM_CLASS} onClick={pick(UNASSIGNED_FILTER)}>
        No person<MenuCheck on={filters.person === UNASSIGNED_FILTER} />
      </DropdownMenuItem>
      {choices.offerOperator && (
        <DropdownMenuItem className={ITEM_CLASS} onClick={pick(OPERATOR_ASSIGNEE)}>
          Operator<MenuCheck on={filters.person === OPERATOR_ASSIGNEE} />
        </DropdownMenuItem>
      )}
      {choices.people.map((person) => (
        <DropdownMenuItem key={person.id} className={ITEM_CLASS} onClick={pick(memberIdentity(person.id))}>
          <HumanAvatar name={person.displayName} initials={person.initials} size={20} />
          {person.displayName}<MenuCheck on={filters.person === memberIdentity(person.id)} />
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** The Agent filter's rows: Anyone, No agent, then every employee. */
function AgentItems({ filters, onChange, employees }: { filters: TodoFilters; onChange: (next: TodoFilters) => void; employees: Employee[] }) {
  return (
    <>
      <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, agent: undefined })}>
        Anyone<MenuCheck on={!filters.agent} />
      </DropdownMenuItem>
      <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, agent: UNASSIGNED_FILTER })}>
        No agent<MenuCheck on={filters.agent === UNASSIGNED_FILTER} />
      </DropdownMenuItem>
      {employees.map((employee) => (
        <DropdownMenuItem key={employee.name} className={ITEM_CLASS} onClick={() => onChange({ ...filters, agent: employee.name })}>
          <EmployeeAvatar name={employee.name} size={20} fontSize={10} className="bg-[var(--fill-secondary)]" />
          {employee.displayName}<MenuCheck on={filters.agent === employee.name} />
        </DropdownMenuItem>
      ))}
    </>
  )
}

export function FilterBar({
  filters,
  onChange,
  employees,
  departments,
  byName,
  hideStatus,
  hideDepartment,
  board,
  personBoard,
  onManageSprints,
}: {
  filters: TodoFilters
  onChange: (next: TodoFilters) => void
  employees: Employee[]
  departments: string[]
  byName: Map<string, Employee>
  /** Board scopes own these dimensions (columns = status, a department board
   *  = its department), so their chips leave the menu there (slice 6). */
  hideStatus?: boolean
  hideDepartment?: boolean
  /** The board's filter row wears the mock geometry (chips left, compact
   *  right search — stage-A review F1); the legacy list keeps the search-led
   *  row until the stage-C cutover retires it. */
  board?: boolean
  /** The department whose people the Person filter offers; none (Everything) offers every active person. */
  personBoard?: string | null
  /** Opens the sprint planner; the Sprint chip's last row. */
  onManageSprints?: () => void
}) {
  const mobile = useIsTodoMobile()
  const labelRegistry = useLabelRegistry(!!board)
  const sprints = useSprints(!!board)
  const [mobileOpen, setMobileOpen] = useState(false)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const wasMobileRef = useRef(mobile)
  const filterTriggerOwnsFocusRef = useRef(false)
  const { openSearch } = useSearchOverlay()
  const openTodoSearch = useCallback((query?: string) => openSearch({ scope: "todo", query }), [openSearch])
  useEffect(() => {
    const releaseFocusOwnership = (event: FocusEvent | PointerEvent) => {
      const target = event.target
      if (target === filterTriggerRef.current) return
      if (event.type === "focusin" && target === document.body) return
      filterTriggerOwnsFocusRef.current = false
    }
    document.addEventListener("focusin", releaseFocusOwnership)
    document.addEventListener("pointerdown", releaseFocusOwnership, true)
    return () => {
      document.removeEventListener("focusin", releaseFocusOwnership)
      document.removeEventListener("pointerdown", releaseFocusOwnership, true)
    }
  }, [])
  useEffect(() => {
    const previousMobile = wasMobileRef.current
    const crossed = previousMobile !== mobile
    wasMobileRef.current = mobile
    if (!crossed) return
    const crossedToDesktopWithSheet = previousMobile && !mobile && mobileOpen
    if (crossedToDesktopWithSheet) {
      setMobileOpen(false)
    }
    const shouldTransfer = crossedToDesktopWithSheet || filterTriggerOwnsFocusRef.current
    if (!shouldTransfer) return
    queueMicrotask(() => filterTriggerRef.current?.focus())
  }, [mobile, mobileOpen])

  // `/` is the board's search shortcut, but only when nothing is being typed
  // into — inside a field it is just a slash.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
      e.preventDefault()
      openTodoSearch()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [openTodoSearch])

  const ownFilterTriggerFocus = () => {
    filterTriggerOwnsFocusRef.current = true
  }

  const active = activeFilterCount(filters)
  const personChoices = usePersonFilterChoices(personBoard)
  const personName = personFilterLabel(filters.person, personChoices)
  const agentName = agentFilterLabel(filters.agent, byName)
  const statusLabel = filters.status === "open" ? null : (STATUS_OPTIONS.find((s) => s.value === filters.status)?.label ?? filters.status)
  const sourceLabel = SOURCE_OPTIONS.find((s) => s.value === filters.source)?.label
  const dateLabel = DATE_OPTIONS.find((d) => d.value === filters.date)?.label
  const dueLabel = DUE_OPTIONS.find((d) => d.value === filters.due)?.label
  const setLabel = filters.label
    ? (labelRegistry.data ?? []).find((l) => l.name === filters.label || l.id === filters.label) ?? { name: filters.label, color: null }
    : null

  const sprintLabel = sprintFilterLabel(filters.sprint, sprints.data)

  if (board && !mobile) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="todos-filters">
        <ValueChip label="Person" set={!!filters.person} display={personName} testId="filter-chip-person">
          <PersonItems filters={filters} onChange={onChange} choices={personChoices} />
        </ValueChip>

        <ValueChip label="Agent" set={!!filters.agent} display={agentName} testId="filter-chip-agent">
          <AgentItems filters={filters} onChange={onChange} employees={employees} />
        </ValueChip>

        <ValueChip
          label="Label"
          set={!!filters.label}
          display={
            setLabel && (
              <span className="flex items-center gap-[5px]">
                <span className="size-[5px] rounded-full" style={{ background: setLabel.color ?? "currentColor" }} />
                {setLabel.name}
              </span>
            )
          }
          testId="filter-chip-label"
        >
          <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, label: undefined })}>
            Any label<MenuCheck on={!filters.label} />
          </DropdownMenuItem>
          {(labelRegistry.data ?? []).map((label) => (
            <DropdownMenuItem key={label.id} className={ITEM_CLASS} onClick={() => onChange({ ...filters, label: label.name })}>
              <span className="size-[5px] rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
              {label.name}<MenuCheck on={filters.label === label.name || filters.label === label.id} />
            </DropdownMenuItem>
          ))}
          {(labelRegistry.data ?? []).length === 0 && (
            <DropdownMenuLabel className="px-3 py-2 text-[length:var(--text-caption1)] font-normal text-[var(--text-tertiary)]">No labels yet.</DropdownMenuLabel>
          )}
        </ValueChip>

        <ValueChip label="Sprint" set={!!filters.sprint} display={sprintLabel} testId="filter-chip-sprint">
          <SprintFilterItems
            value={filters.sprint}
            sprints={sprints.data}
            onChoose={(sprint) => onChange({ ...filters, sprint })}
            onManage={onManageSprints}
            itemClassName={ITEM_CLASS}
          />
        </ValueChip>

        <ValueChip label="Due" set={!!filters.due} display={dueLabel} testId="filter-chip-due">
          {DUE_OPTIONS.map((option) => (
            <DropdownMenuItem key={option.label} className={ITEM_CLASS} onClick={() => onChange({ ...filters, due: option.value })}>
              {option.label}<MenuCheck on={filters.due === option.value} />
            </DropdownMenuItem>
          ))}
        </ValueChip>

        {/* The rest of the platform's filter grammar, kept reachable. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More filters"
              data-testid="filter-chip-more"
              className="focus-outline grid h-[30px] w-[34px] flex-none place-items-center rounded-[15px] bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
            >
              <MoreHorizontal size={14} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={MENU_CLASS}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Source</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: undefined })}>
                  Any source<MenuCheck on={!filters.source} />
                </DropdownMenuItem>
                {SOURCE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: option.value })}>
                    {option.label}<MenuCheck on={filters.source === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Date</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                {DATE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.label} className={ITEM_CLASS} onClick={() => onChange({ ...filters, date: option.value })}>
                    {option.label}<MenuCheck on={filters.date === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!hideDepartment && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={ITEM_CLASS}>Department</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={SUBMENU_CLASS}>
                  <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, department: undefined })}>
                    Any department<MenuCheck on={!filters.department} />
                  </DropdownMenuItem>
                  {departments.map((department) => (
                    <DropdownMenuItem key={department} className={ITEM_CLASS} onClick={() => onChange({ ...filters, department })}>
                      {department.charAt(0).toUpperCase() + department.slice(1)}<MenuCheck on={filters.department === department} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {active > 0 && (
              <DropdownMenuItem className={`${ITEM_CLASS} mt-1 text-[var(--text-secondary)]`} onClick={() => onChange({ status: "open" })}>
                Clear all filters
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Dimensions living behind ⋯ surface their SET state inline. */}
        {sourceLabel && <BoardActiveChip label={sourceLabel} onRemove={() => onChange({ ...filters, source: undefined })} />}
        {filters.date && dateLabel && <BoardActiveChip label={dateLabel} onRemove={() => onChange({ ...filters, date: undefined })} />}
        {filters.department && !hideDepartment && (
          <BoardActiveChip
            label={filters.department.charAt(0).toUpperCase() + filters.department.slice(1)}
            onRemove={() => onChange({ ...filters, department: undefined })}
          />
        )}
        {/* Talk deep-links `?q=`. Without the old field there is nothing else
            on the board that shows it is set, or clears it. */}
        {filters.q && <BoardActiveChip label={`Matching "${filters.q}"`} onRemove={() => onChange({ ...filters, q: undefined })} />}

        <SearchLauncher
          className="ml-auto flex h-[30px] w-[190px] flex-none items-center gap-[7px] rounded-[15px] bg-[var(--fill-tertiary)] px-3"
          iconSize={13}
          labelClassName="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--text-quaternary)]"
          onOpen={openTodoSearch}
        />
      </div>
    )
  }

  return (
    <div className="mb-5" data-testid="todos-filters">
      <div className="flex items-center gap-2">
        <SearchLauncher
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[14px] bg-[var(--fill-tertiary)] px-3.5"
          iconSize={16}
          labelClassName="min-w-0 flex-1 truncate text-left text-[length:var(--text-subheadline)] text-[var(--text-quaternary)]"
          onOpen={openTodoSearch}
        />

        {mobile ? (
          <button
            ref={filterTriggerRef}
            type="button"
            aria-label="Filter todos"
            onClick={() => setMobileOpen(true)}
            onFocus={ownFilterTriggerFocus}
            className={`inline-flex min-h-11 flex-none items-center gap-2 rounded-[14px] px-3.5 text-[length:var(--text-subheadline)] font-medium transition-[background-color,color,transform] active:scale-[0.96] ${
              active > 0
                ? "bg-[var(--accent-fill)] text-[var(--accent)]"
                : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
            }`}
          >
            <Filter size={16} aria-hidden />
            <span className="max-[420px]:sr-only">Filter</span>
            {active > 0 && <span className="tabular-nums">{active}</span>}
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                ref={filterTriggerRef}
                type="button"
                aria-label="Filter todos"
                onFocus={ownFilterTriggerFocus}
                className={`inline-flex min-h-11 flex-none items-center gap-2 rounded-[14px] px-3.5 text-[length:var(--text-subheadline)] font-medium transition-colors ${
                  active > 0
                    ? "bg-[var(--accent-fill)] text-[var(--accent)]"
                    : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
                }`}
              >
                <Filter size={16} aria-hidden />
                <span className="max-[420px]:sr-only">Filter</span>
                {active > 0 && <span className="tabular-nums">{active}</span>}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CLASS}>
            <DropdownMenuLabel className="px-3 pb-1 pt-2 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              Refine this view
            </DropdownMenuLabel>

            {!hideStatus && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={ITEM_CLASS}>Status</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={SUBMENU_CLASS}>
                  {STATUS_OPTIONS.map((option) => (
                    <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, status: option.value })}>
                      {option.label}<MenuCheck on={filters.status === option.value} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Person</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <PersonItems filters={filters} onChange={onChange} choices={personChoices} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Agent</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <AgentItems filters={filters} onChange={onChange} employees={employees} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {!hideDepartment && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className={ITEM_CLASS}>Department</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={SUBMENU_CLASS}>
                  <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, department: undefined })}>
                    Any department<MenuCheck on={!filters.department} />
                  </DropdownMenuItem>
                  {departments.map((department) => (
                    <DropdownMenuItem key={department} className={ITEM_CLASS} onClick={() => onChange({ ...filters, department })}>
                      {department.charAt(0).toUpperCase() + department.slice(1)}<MenuCheck on={filters.department === department} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Source</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                <DropdownMenuItem className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: undefined })}>
                  Any source<MenuCheck on={!filters.source} />
                </DropdownMenuItem>
                {SOURCE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} className={ITEM_CLASS} onClick={() => onChange({ ...filters, source: option.value })}>
                    {option.label}<MenuCheck on={filters.source === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM_CLASS}>Date</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={SUBMENU_CLASS}>
                {DATE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.label} className={ITEM_CLASS} onClick={() => onChange({ ...filters, date: option.value })}>
                    {option.label}<MenuCheck on={filters.date === option.value} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {active > 0 && (
              <DropdownMenuItem className={`${ITEM_CLASS} mt-1 text-[var(--text-secondary)]`} onClick={() => onChange({ status: "open" })}>
                Clear all filters
              </DropdownMenuItem>
            )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {active > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Active filters">
          {statusLabel && <ActiveChip label={`Status: ${statusLabel}`} onRemove={() => onChange({ ...filters, status: "open" })} />}
          {personName && <ActiveChip label={`Person: ${personName}`} onRemove={() => onChange({ ...filters, person: undefined })} />}
          {agentName && <ActiveChip label={`Agent: ${agentName}`} onRemove={() => onChange({ ...filters, agent: undefined })} />}
          {filters.department && (
            <ActiveChip
              label={`Department: ${filters.department.charAt(0).toUpperCase() + filters.department.slice(1)}`}
              onRemove={() => onChange({ ...filters, department: undefined })}
            />
          )}
          {sourceLabel && <ActiveChip label={`Source: ${sourceLabel}`} onRemove={() => onChange({ ...filters, source: undefined })} />}
          {filters.date && dateLabel && <ActiveChip label={`Date: ${dateLabel}`} onRemove={() => onChange({ ...filters, date: undefined })} />}
        </div>
      )}

      {mobile && mobileOpen && (
        <LazyTodoFilterSheet
          filters={filters}
          onChange={onChange}
          employees={employees}
          departments={departments}
          byName={byName}
          onClose={() => setMobileOpen(false)}
          hideStatus={hideStatus}
          hideDepartment={hideDepartment}
          showLabelDue={board}
          personBoard={personBoard}
        />
      )}
    </div>
  )
}

