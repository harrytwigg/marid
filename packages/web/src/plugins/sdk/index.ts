/**
 * `@jinn/plugin-sdk` — the one module a Jinn plugin imports.
 *
 * Everything here is the app's own instance, never a copy. React in particular
 * is the mechanism and not a convenience: a plugin that resolved a second React
 * would get a second dispatcher, and every hook it called would throw. The
 * bundled path reaches this file through a Vite alias; the runtime loader
 * re-exports this same namespace off a global. Both land on this object.
 *
 * The public type contract is the hand-authored `sdk.d.ts` beside this file,
 * and a test holds the two in exact two-way sync.
 */
import React from 'react'

export { React }
export { Fragment, jsx, jsxs } from 'react/jsx-runtime'

export { queryClient } from '@/lib/query-client'
export { cn } from '@/lib/utils'

export { Badge } from '@/components/ui/badge'
export { Button } from '@/components/ui/button'
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
// Name-keyed rather than a component the plugin imports: the loader's allowlist
// is this module, React and the JSX runtime, so an icon library is out of reach.
export { Icon } from '@/components/ui/icon'
export type { IconName } from '@/components/ui/icon'
export { Input } from '@/components/ui/input'
export { ScrollArea } from '@/components/ui/scroll-area'
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
export { Skeleton } from '@/components/ui/skeleton'
export { Switch } from '@/components/ui/switch'
export { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
export { Textarea } from '@/components/ui/textarea'
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export { AREAS } from './areas'
export type { AreaId } from './areas'

export { useRouteParams } from './route-params'

export { host, PluginSdkError } from './host'
export type { PluginHost } from './host'
export { PluginHostDeniedError } from './host-permissions'
export type { PluginHostVerb } from './host-permissions'
export type {
  HostConnectorMessage,
  HostCronJob,
  HostCronRun,
  HostEmployee,
  HostKnowledgeResult,
  HostNote,
  HostNoteContent,
  HostNoteDraft,
  HostSession,
  HostSessionSpawn,
  HostTodo,
  HostTodoComment,
  HostTodoDraft,
  HostTodoFilter,
  HostTodoStatus,
  PluginHostConnectors,
  PluginHostCron,
  PluginHostEmployees,
  PluginHostKnowledge,
  PluginHostNotes,
  PluginHostSessions,
  PluginHostTodos,
} from './host-verbs'
export type { HostEvent, HostEventHandler } from './host-events'
export type { GatewayStatus, HostState } from './host-state'
export type { HostNotice, HostNotifyLevel } from './host-bridge'

export { SDK_CONTRACT_VERSION } from './version'
