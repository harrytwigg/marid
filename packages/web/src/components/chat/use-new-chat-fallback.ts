import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import {
  parseFallbackView,
  withMode,
  withTarget,
  type FallbackTargetChoice,
  type SessionFallbackMode,
  type SessionFallbackView,
} from './fallback-mode-model'
import type { FallbackChange, FallbackSave } from './use-fallback-view'

/** What the operator has chosen for the chat they are about to start; absent fields follow the config. */
export interface NewChatFallbackChoice {
  mode?: SessionFallbackMode
  target?: FallbackTargetChoice
}

/** The create-request fields for a choice: nothing at all when the operator chose nothing. */
export function newChatFallbackParams(choice: NewChatFallbackChoice): { fallbackMode?: SessionFallbackMode; fallbackTarget?: FallbackTargetChoice } {
  return { ...(choice.mode ? { fallbackMode: choice.mode } : {}), ...(choice.target ? { fallbackTarget: choice.target } : {}) }
}

function applyChoice(view: SessionFallbackView, choice: NewChatFallbackChoice): SessionFallbackView {
  const withChosenMode = choice.mode ? withMode(view, choice.mode) : view
  return choice.target ? withTarget(withChosenMode, choice.target) : withChosenMode
}

/**
 * The fallback chip's state on the new-chat screen: the view a session with this selection would
 * start with (from the gateway, so the default mode, the chain's target and the engines it may pick
 * are the real ones), with the operator's choice laid over it. The choice is sent on the create
 * request. A choice made for one employee is dropped when another is picked, because what a session
 * may fall back to depends on who it is for.
 */
export function useNewChatFallback(opts: { active: boolean; engine?: string; model?: string; employee?: string }) {
  const { active, engine, model, employee } = opts
  const [choice, setChoice] = useState<NewChatFallbackChoice>({})
  useEffect(() => { setChoice({}) }, [employee, active])

  // The preview for the selection, kept while the next one loads so the chip does not blink on a model change.
  // No cache: it is one small read per selection, and an older gateway without the route just shows no chip, and a choice the chip no longer shows is dropped rather than sent.
  const [base, setBase] = useState<SessionFallbackView | null>(null)
  useEffect(() => {
    if (!active) return
    let stale = false
    const load = async () => parseFallbackView((await api.getFallbackPreview({ engine, model, employee })).fallback)
    load().then((next) => { if (!stale) setBase(next) }).catch(() => { if (!stale) { setBase(null); setChoice({}) } })
    return () => { stale = true }
  }, [active, engine, model, employee])
  const view = useMemo(() => (base ? applyChoice(base, choice) : null), [base, choice])

  const save: FallbackSave = useCallback((change: FallbackChange) => {
    setChoice((prev) => {
      const next = { ...prev }
      if (change.fallbackMode) next.mode = change.fallbackMode
      if (change.fallbackTarget !== undefined) {
        if (change.fallbackTarget) next.target = change.fallbackTarget
        else delete next.target
      }
      return next
    })
    return Promise.resolve(undefined)
  }, [])

  return { view, save, choice }
}
