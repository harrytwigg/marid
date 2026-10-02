import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { talkNavigator } from "../tools/router-handle"

export interface TalkUiEffect {
  invalidate?: string[]
  navigate?: string
  focus?: string
}

const EXACT_KEYS: Record<string, readonly unknown[]> = {
  todos: ["work-items"],
  sessions: queryKeys.sessions.all,
}

const KEY_BUILDERS: Record<string, (parts: string[]) => readonly unknown[] | null> = {
  todo: ([id]) => ["work-item", id],
  "todo-comments": ([id]) => ["work-item-comments", id],
  "todo-sessions": ([id]) => ["work-item-sessions", id],
  session: ([id]) => queryKeys.sessions.detail(id!),
}

function queryKey(effect: string): readonly unknown[] | null {
  const exact = EXACT_KEYS[effect]
  if (exact) return exact
  const [kind, ...rest] = effect.split(":")
  if (!rest[0]) return null
  return KEY_BUILDERS[kind]?.(rest) ?? null
}

export async function applyTalkUiEffect(effect: TalkUiEffect | null): Promise<void> {
  if (!effect) return
  await Promise.all((effect.invalidate ?? []).map((entry) => {
    const key = queryKey(entry)
    return key ? queryClient.invalidateQueries({ queryKey: key }) : Promise.resolve()
  }))
  if (effect.navigate) {
    const navigate = talkNavigator()
    if (!navigate) throw new Error("The app router is unavailable.")
    await navigate(effect.navigate)
  }
  if (effect.focus) {
    const target = document.querySelector<HTMLElement>(`[data-talk-target="${CSS.escape(effect.focus)}"]`)
    target?.focus({ preventScroll: false })
    target?.scrollIntoView({ block: "center", behavior: "smooth" })
  }
}
