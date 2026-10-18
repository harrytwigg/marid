/**
 * The UI half of the public contract, re-exported by `sdk.d.ts`.
 *
 * It sits in its own file because it is its own concern — the app's components,
 * declared over the props a contribution actually sets — and because the two
 * halves are read by different people: this one by whoever is laying a page
 * out, the other by whoever is talking to the host.
 *
 * The wrappers forward the rest of their props to their Radix roots, but
 * spelling Radix's generics out here would put a Radix version into the public
 * contract, and a plugin that never installs Radix could not typecheck against
 * it.
 */
import type {
  ButtonHTMLAttributes,
  ComponentType,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react'

/* The UI primitives are declared over the props a contribution actually sets.
 * The wrappers forward the rest to their Radix roots, but spelling Radix's
 * generics out here would put a Radix version into the public contract, and a
 * plugin that never installs Radix could not typecheck against it. */
interface Styled {
  className?: string
  children?: ReactNode
}

type DivProps = HTMLAttributes<HTMLDivElement>

export declare const Button: ComponentType<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
    size?: 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
    asChild?: boolean
  }
>

export declare const Badge: ComponentType<
  HTMLAttributes<HTMLSpanElement> & {
    variant?: 'default' | 'secondary' | 'success' | 'warning' | 'destructive'
    asChild?: boolean
  }
>

export declare const Card: ComponentType<DivProps>
export declare const CardHeader: ComponentType<DivProps>
export declare const CardTitle: ComponentType<DivProps>
export declare const CardDescription: ComponentType<DivProps>
export declare const CardContent: ComponentType<DivProps>
export declare const CardFooter: ComponentType<DivProps>

export declare const Dialog: ComponentType<{
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: ReactNode
}>
export declare const DialogTrigger: ComponentType<Styled & { asChild?: boolean }>
export declare const DialogContent: ComponentType<
  Styled & { showCloseButton?: boolean; overlayClassName?: string }
>
export declare const DialogHeader: ComponentType<DivProps>
export declare const DialogTitle: ComponentType<Styled>
export declare const DialogDescription: ComponentType<Styled>
export declare const DialogFooter: ComponentType<DivProps & { showCloseButton?: boolean }>
export declare const DialogClose: ComponentType<Styled & { asChild?: boolean }>

type Side = 'top' | 'right' | 'bottom' | 'left'
type Align = 'start' | 'center' | 'end'

export declare const DropdownMenu: ComponentType<{
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: ReactNode
}>
export declare const DropdownMenuTrigger: ComponentType<
  ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>
export declare const DropdownMenuContent: ComponentType<
  DivProps & { side?: Side; sideOffset?: number; align?: Align }
>
export declare const DropdownMenuGroup: ComponentType<DivProps>
export declare const DropdownMenuLabel: ComponentType<DivProps & { inset?: boolean }>
export declare const DropdownMenuItem: ComponentType<
  DivProps & {
    onSelect?: (event: Event) => void
    disabled?: boolean
    inset?: boolean
    variant?: 'default' | 'destructive'
  }
>
export declare const DropdownMenuSeparator: ComponentType<DivProps>

/** The names the app's icon set carries. A plugin names a glyph rather than
 *  importing one: the loader resolves this module, React and the JSX runtime,
 *  and no icon library, so a component could never reach it. */
export type IconName =
  | 'activity'
  | 'bell'
  | 'calendar'
  | 'check'
  | 'check-circle'
  | 'chevron-down'
  | 'chevron-right'
  | 'clock'
  | 'external-link'
  | 'file'
  | 'filter'
  | 'folder'
  | 'inbox'
  | 'info'
  | 'link'
  | 'list'
  | 'mail'
  | 'message'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'sparkles'
  | 'star'
  | 'tag'
  | 'trash'
  | 'user'
  | 'users'
  | 'warning'
  | 'x'
  | 'zap'

/** Renders nothing and says so on the console when the name is not in the set,
 *  rather than leaving an unexplained hole. */
export declare const Icon: ComponentType<{
  name: IconName
  size?: number | string
  className?: string
  'aria-label'?: string
}>

export declare const Input: ComponentType<InputHTMLAttributes<HTMLInputElement>>

/** A scrolling panel with the app's own overlay scrollbar. Give it a height;
 *  it scrolls what overflows one. */
export declare const ScrollArea: ComponentType<DivProps>

export declare const Select: ComponentType<{
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  children?: ReactNode
}>
export declare const SelectTrigger: ComponentType<Styled & { disabled?: boolean }>
export declare const SelectValue: ComponentType<{ placeholder?: ReactNode; className?: string }>
export declare const SelectContent: ComponentType<Styled>
export declare const SelectItem: ComponentType<Styled & { value: string; disabled?: boolean }>

export declare const Skeleton: ComponentType<
  DivProps & { width?: number | string; height?: number | string }
>

export declare const Switch: ComponentType<{
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
}>

export declare const Tabs: ComponentType<
  Styled & {
    value?: string
    defaultValue?: string
    onValueChange?: (value: string) => void
    orientation?: 'horizontal' | 'vertical'
  }
>
export declare const TabsList: ComponentType<Styled & { variant?: 'default' | 'line' }>
export declare const TabsTrigger: ComponentType<Styled & { value: string; disabled?: boolean }>
export declare const TabsContent: ComponentType<Styled & { value: string }>

export declare const Textarea: ComponentType<TextareaHTMLAttributes<HTMLTextAreaElement>>

/** Carries its own provider, so one tooltip works on its own. Wrap a group in
 *  `TooltipProvider` when they should share an open delay. It opens on hover and
 *  on keyboard focus, closes on Escape, blur and press, and describes its trigger
 *  with `aria-describedby` while it is open. The trigger must be focusable, and
 *  `asChild` hands the props to the one child (which must pass `ref` through). */
export declare const Tooltip: ComponentType<{
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
  children?: ReactNode
}>
export declare const TooltipTrigger: ComponentType<
  ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>
/** `className`, `style`, `data-*`, `aria-*`, `title`, `id` and the mouse, pointer and touch handlers are
 *  forwarded to the tooltip. `role` (always `tooltip`) and the key and focus handlers are ignored: Escape,
 *  focus and blur belong to the trigger's tooltip behaviour. */
export declare const TooltipContent: ComponentType<
  DivProps & { side?: Side; sideOffset?: number; align?: Align }
>
export declare const TooltipProvider: ComponentType<{
  delayDuration?: number
  children?: ReactNode
}>
