import { CheckIcon, ChevronDownIcon } from "@/components/ui/icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ModelListPanel } from "@/components/chat/model-picker-panels"
import { useModelList } from "@/components/chat/use-model-list"
import { accountBadgeText, accountOfModel, useAccountLabels, useAccountProviders } from "@/hooks/account-labels"
import { providerOf } from "@/hooks/use-model-registry"
import type { EnginesResponse, ModelInfo } from "@/lib/api"

/** The account the picked model is served through, and what its badge reads. */
function usePickedBadge(picked: ModelInfo | undefined): { account: string | undefined; badge: string | null } {
  const labels = useAccountLabels()
  const providers = useAccountProviders()
  const account = picked ? accountOfModel(picked, providerOf(picked.id), providers) : undefined
  return { account, badge: account ? accountBadgeText(account, labels) : null }
}

/** A row's model: the shared picker's own search and short list, behind a trigger
 *  that reads like the row's selects. The first row is "no model", which is
 *  `noModelText` in words and writes nothing. A model the registry does not list
 *  (one pinned by hand) is still shown as its id. */
export function ChainModelSelect({ registry, engine, value, noModelText, ariaLabel, onChange }: {
  registry: EnginesResponse
  engine: string
  /** The row's model id, or "" for none. */
  value: string
  noModelText: string
  ariaLabel: string
  onChange: (model: string) => void
}) {
  const list = useModelList(registry, engine, value)
  const picked = value ? list.models.find((m) => m.id === value) : undefined
  const shown = picked?.label ?? (value || noModelText)
  const { account, badge } = usePickedBadge(picked)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${ariaLabel}: ${shown}${badge ? ` (${badge})` : ""}`}
          title={value || undefined}
          className="select__trigger relative min-h-[40px] w-full cursor-pointer appearance-none pe-8 text-left text-[length:var(--text-footnote)] max-md:text-[length:max(1rem,var(--text-body))] md:min-h-0"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{shown}</span>
            {badge && (
              <span data-account-badge={account} className="shrink-0 rounded-[5px] bg-[var(--fill-tertiary)] px-1 py-px text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                {badge}
              </span>
            )}
          </span>
          <ChevronDownIcon aria-hidden className="select__indicator pointer-events-none size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} collisionPadding={16} className="w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] p-1.5">
        <DropdownMenuItem
          onSelect={() => onChange("")}
          className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
        >
          <span className={value === "" ? "font-[var(--weight-semibold)] text-[var(--text-primary)]" : undefined}>{noModelText}</span>
          {value === "" && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-[var(--separator)]" />
        <ModelListPanel engine={engine} modelId={value} list={list} onPickModel={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
